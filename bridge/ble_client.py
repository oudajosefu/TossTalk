"""BLE client for TossTalk - connects, parses audio frames, handles reconnection."""

import asyncio
import logging
import struct
from collections.abc import Callable

import numpy as np
from bleak import BleakClient, BleakScanner
from bleak.backends.characteristic import BleakGATTCharacteristic

from . import adpcm

log = logging.getLogger(__name__)

# ── BLE UUIDs ─────────────────────────────────────────────────────────────
SERVICE_UUID = "9f8d0001-6b7b-4f26-b10f-3aa861aa0001"
AUDIO_CHAR_UUID = "9f8d0002-6b7b-4f26-b10f-3aa861aa0001"
BATT_CHAR_UUID = "9f8d0003-6b7b-4f26-b10f-3aa861aa0001"
STATE_CHAR_UUID = "9f8d0004-6b7b-4f26-b10f-3aa861aa0001"

# ── Audio constants ───────────────────────────────────────────────────────
SAMPLE_COUNT = 160
MAX_CONCEAL = 2
SETTLE_MS = 3500

# ── Gate state names ──────────────────────────────────────────────────────
GATE_NAMES = ["UnmutedLive", "AirborneSuppressed", "ImpactLockout", "Reacquire"]

AudioCallback = Callable[[np.ndarray], None]
StatusCallback = Callable[[str, object], None]


class TossTalkBleClient:
    """Async BLE client that connects to a TossTalk device and streams decoded PCM."""

    def __init__(
        self,
        audio_cb: AudioCallback,
        status_cb: StatusCallback | None = None,
        device_name: str = "TossTalk",
    ):
        self.audio_cb = audio_cb
        self.status_cb = status_cb or (lambda *_: None)
        self.device_name = device_name

        # Connection state
        self._client: BleakClient | None = None
        self._address: str | None = None
        self._running = False

        # Sub-packet reassembly state
        self._assembly_seq: int | None = None
        self._assembly_pkts: int = 0
        self._assembly_adpcm = bytearray(80)
        self._assembly_pred: int = 0
        self._assembly_idx: int = 0
        self._assembly_muted: bool = False

        # Sequence tracking
        self._last_complete_seq: int | None = None

        # Stats
        self.frames = 0
        self.drops = 0
        self.muted_frames = 0
        self.concealed_frames = 0
        self.sub_pkts = 0

    # ── Scanning & connection ─────────────────────────────────────────────

    async def scan(self, timeout: float = 10.0) -> str | None:
        """Scan for a TossTalk device. Returns BLE address or None."""
        self.status_cb("connection", "Scanning...")
        log.info("Scanning for %s (timeout %.0fs)...", self.device_name, timeout)

        device = await BleakScanner.find_device_by_name(
            self.device_name, timeout=timeout
        )
        if device:
            log.info("Found %s at %s", device.name, device.address)
            self._address = device.address
            return device.address

        # Fallback: scan by service UUID
        device = await BleakScanner.find_device_by_filter(
            lambda d, ad: (
                SERVICE_UUID.lower() in [s.lower() for s in (ad.service_uuids or [])]
            ),
            timeout=timeout,
        )
        if device:
            log.info("Found device by UUID at %s", device.address)
            self._address = device.address
            return device.address

        log.warning("No TossTalk device found")
        self.status_cb("connection", "Device not found")
        return None

    async def connect(self) -> bool:
        """Connect to the device, set up notifications. Returns True on success."""
        if not self._address:
            if not await self.scan():
                return False

        self.status_cb("connection", "Connecting...")
        log.info("Connecting to %s...", self._address)

        if self._address is None:
            return False

        def on_disconnect(_client: BleakClient) -> None:
            log.warning("Disconnected from device")
            self.status_cb("connection", "Disconnected")

        self._client = BleakClient(
            self._address,
            timeout=15.0,
            disconnected_callback=on_disconnect,
        )

        try:
            await self._client.connect()
        except Exception as e:
            log.error("GATT connect failed: %s", e)
            self.status_cb("connection", f"Connect failed: {e}")
            self._client = None
            return False

        # Wait for firmware to settle (matches firmware SETTLE_MS)
        self.status_cb("connection", "Waiting for device to settle...")
        log.info("Waiting %dms for device to settle...", SETTLE_MS)
        await asyncio.sleep(SETTLE_MS / 1000)

        try:
            # Subscribe to notifications
            self.status_cb("connection", "Starting notifications...")
            await self._client.start_notify(BATT_CHAR_UUID, self._handle_battery)
            await self._client.start_notify(STATE_CHAR_UUID, self._handle_state)
            await self._client.start_notify(AUDIO_CHAR_UUID, self._handle_audio)
            log.info("All notifications started")

            # Read initial values
            try:
                batt_data = await self._client.read_gatt_char(BATT_CHAR_UUID)
                if len(batt_data) >= 2:
                    self.status_cb("battery", (batt_data[0], bool(batt_data[1])))
            except Exception:
                pass
            try:
                state_data = await self._client.read_gatt_char(STATE_CHAR_UUID)
                if len(state_data) >= 1:
                    idx = state_data[0]
                    name = (
                        GATE_NAMES[idx] if idx < len(GATE_NAMES) else f"Unknown({idx})"
                    )
                    self.status_cb("gate", name)
            except Exception:
                pass

            self.status_cb("connection", "Connected")
            log.info("Connected and streaming")
            return True

        except Exception as e:
            log.error("Notification setup failed: %s", e)
            self.status_cb("connection", f"Setup failed: {e}")
            await self._safe_disconnect()
            return False

    async def _safe_disconnect(self) -> None:
        if self._client:
            try:
                await self._client.disconnect()
            except Exception:
                pass
            self._client = None

    async def disconnect(self) -> None:
        """Disconnect from the device."""
        self._running = False
        await self._safe_disconnect()
        self.status_cb("connection", "Disconnected")

    @property
    def is_connected(self) -> bool:
        return self._client is not None and self._client.is_connected

    # ── Main run loop with auto-reconnect ─────────────────────────────────

    async def run(self) -> None:
        """Run the client with auto-reconnect. Blocks until stop() is called."""
        self._running = True
        backoff = 1.0

        while self._running:
            if not self.is_connected:
                ok = await self.connect()
                if not ok:
                    log.info("Retrying in %.0fs...", backoff)
                    self.status_cb("connection", f"Retrying in {backoff:.0f}s...")
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 30.0)
                    continue
                backoff = 1.0

            # Wait until disconnected
            while self._running and self.is_connected:
                await asyncio.sleep(0.5)

            if self._running:
                log.info("Connection lost, will reconnect...")
                self._reset_assembly()
                await asyncio.sleep(1.0)

    def stop(self) -> None:
        """Signal the run loop to stop."""
        self._running = False

    # ── Notification handlers ─────────────────────────────────────────────

    def _handle_battery(self, _char: BleakGATTCharacteristic, data: bytearray) -> None:
        if len(data) >= 2:
            self.status_cb("battery", (data[0], bool(data[1])))

    def _handle_state(self, _char: BleakGATTCharacteristic, data: bytearray) -> None:
        if len(data) >= 1:
            idx = data[0]
            name = GATE_NAMES[idx] if idx < len(GATE_NAMES) else f"Unknown({idx})"
            self.status_cb("gate", name)

    def _handle_audio(self, _char: BleakGATTCharacteristic, data: bytearray) -> None:
        try:
            if len(data) < 2:
                return
            self.sub_pkts += 1

            seq = data[0]
            byte1 = data[1]
            pkt_idx = byte1 & 0x0F
            muted = bool(byte1 & 0x80)

            # Single-packet mode (MTU >= 88)
            if pkt_idx == 0 and len(data) >= 85:
                # Finalize any in-progress sub-packet assembly
                if self._assembly_seq is not None and self._assembly_pkts != 0:
                    self._finalize_frame()
                self._reset_assembly()

                pred = struct.unpack_from("<h", data, 2)[0]
                idx = data[4]
                adpcm_data = bytes(data[5:85])

                self._inject_concealment(seq)
                self._last_complete_seq = seq

                if muted:
                    pcm = np.zeros(SAMPLE_COUNT, dtype=np.int16)
                    self.muted_frames += 1
                else:
                    pcm = adpcm.decode(adpcm_data, SAMPLE_COUNT, pred, idx)

                self.frames += 1
                self.audio_cb(pcm)
                return

            # Sub-packet mode (MTU < 88)
            if seq != self._assembly_seq:
                if self._assembly_seq is not None and self._assembly_pkts != 0:
                    self._finalize_frame()
                self._reset_assembly()
                self._assembly_seq = seq

            self._assembly_muted = self._assembly_muted or muted

            if pkt_idx == 0 and len(data) >= 20:
                self._assembly_pred = struct.unpack_from("<h", data, 2)[0]
                self._assembly_idx = data[4]
                self._assembly_adpcm[0:15] = data[5:20]
                self._assembly_pkts |= 1
            elif 1 <= pkt_idx <= 3 and len(data) >= 20:
                offset = 15 + (pkt_idx - 1) * 18
                self._assembly_adpcm[offset : offset + 18] = data[2:20]
                self._assembly_pkts |= 1 << pkt_idx
            elif pkt_idx == 4 and len(data) >= 13:
                self._assembly_adpcm[69:80] = data[2:13]
                self._assembly_pkts |= 1 << 4

            # All 5 sub-packets received
            if self._assembly_pkts == 0x1F:
                self._finalize_frame()
                self._reset_assembly()

        except Exception:
            log.exception("Error parsing audio packet")

    # ── Assembly helpers ──────────────────────────────────────────────────

    def _reset_assembly(self) -> None:
        self._assembly_seq = None
        self._assembly_pkts = 0
        self._assembly_adpcm = bytearray(80)
        self._assembly_pred = 0
        self._assembly_idx = 0
        self._assembly_muted = False

    def _finalize_frame(self) -> None:
        if self._assembly_muted:
            pcm = np.zeros(SAMPLE_COUNT, dtype=np.int16)
            self.muted_frames += 1
        else:
            pcm = adpcm.decode(
                bytes(self._assembly_adpcm),
                SAMPLE_COUNT,
                self._assembly_pred,
                self._assembly_idx,
            )

        self.frames += 1
        if self._assembly_seq is not None:
            self._inject_concealment(self._assembly_seq)
            self._last_complete_seq = self._assembly_seq
        self.audio_cb(pcm)

    def _inject_concealment(self, seq: int) -> None:
        """Insert silence frames for detected gaps in sequence numbers."""
        if self._last_complete_seq is not None and seq is not None:
            gap = ((seq - self._last_complete_seq + 256) % 256) - 1
            if 0 < gap < 60:
                conceal = min(gap, MAX_CONCEAL)
                for _ in range(conceal):
                    silence = np.zeros(SAMPLE_COUNT, dtype=np.int16)
                    self.concealed_frames += 1
                    self.audio_cb(silence)
