"""TossTalk Virtual Microphone Bridge.

Connects to a TossTalk BLE device, decodes the ADPCM audio stream,
and pipes it to a virtual audio device (VB-Cable) so that apps like
Microsoft Teams can use it as a microphone input.
"""

import argparse
import asyncio
import logging
import signal
import sys
import time

# Force COM to Multi-Threaded Apartment before any library (sounddevice/PortAudio)
# can initialize it as STA. Bleak's WinRT backend requires MTA.
if sys.platform == "win32":
    import ctypes

    ctypes.windll.ole32.CoInitializeEx(0, 0x0)  # COINIT_MULTITHREADED

import numpy as np

try:
    from .audio_output import AudioOutput, find_vb_cable_device, list_output_devices
    from .ble_client import TossTalkBleClient
except ImportError:
    from audio_output import AudioOutput, find_vb_cable_device, list_output_devices
    from ble_client import TossTalkBleClient


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="tosstalk-bridge",
        description="TossTalk Virtual Microphone Bridge — stream BLE audio to a virtual mic",
    )
    p.add_argument(
        "--device-name",
        default="TossTalk",
        help="BLE device name to scan for (default: TossTalk)",
    )
    p.add_argument(
        "--output-device",
        type=int,
        default=None,
        help="Audio output device index (default: auto-detect VB-Cable)",
    )
    p.add_argument(
        "--list-devices",
        action="store_true",
        help="List available audio output devices and exit",
    )
    p.add_argument(
        "--scan-timeout",
        type=float,
        default=10.0,
        help="BLE scan timeout in seconds (default: 10)",
    )
    p.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Enable debug logging",
    )
    p.add_argument(
        "--gain",
        type=float,
        default=None,
        help="Mic gain multiplier (0.0-20.0, default: firmware default 5.0)",
    )
    p.add_argument(
        "--noise-gate",
        type=int,
        default=None,
        help="Noise gate threshold (0-2000, default: firmware default 225)",
    )
    p.add_argument(
        "--soft-limit",
        type=int,
        default=None,
        help="Soft limiter ceiling (1000-32767, default: firmware default 18000)",
    )
    return p.parse_args()


def main() -> None:
    args = parse_args()

    # Console always gets INFO; verbose DEBUG goes to a log file
    root_logger = logging.getLogger()
    root_logger.setLevel(logging.DEBUG if args.verbose else logging.INFO)

    console_handler = logging.StreamHandler()
    console_handler.setLevel(logging.INFO)
    console_handler.setFormatter(
        logging.Formatter(
            "%(asctime)s %(levelname)-5s %(name)s: %(message)s", datefmt="%H:%M:%S"
        )
    )
    root_logger.addHandler(console_handler)

    if args.verbose:
        import os

        log_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "bridge-debug.log",
        )
        file_handler = logging.FileHandler(log_path, mode="w", encoding="utf-8")
        file_handler.setLevel(logging.DEBUG)
        file_handler.setFormatter(
            logging.Formatter(
                "%(asctime)s.%(msecs)03d %(levelname)-5s %(name)s: %(message)s",
                datefmt="%H:%M:%S",
            )
        )
        root_logger.addHandler(file_handler)
        print(f"Verbose logging to: {log_path}")

    if args.list_devices:
        print("Available audio output devices:")
        for idx, name in list_output_devices():
            marker = ""
            if "cable input" in name.lower():
                marker = "  <-- VB-Cable"
            print(f"  [{idx}] {name}{marker}")
        return

    # Verify VB-Cable / output device before starting BLE
    device_idx = args.output_device
    if device_idx is None:
        device_idx = find_vb_cable_device()
        if device_idx is None:
            print(
                "ERROR: VB-Cable not found.\n"
                "Install VB-Cable from https://vb-audio.com/Cable/ and restart.\n"
                "Or use --list-devices to find your device index, then --output-device <index>.",
                file=sys.stderr,
            )
            sys.exit(1)
        print(f"Auto-detected VB-Cable (device {device_idx})")
    else:
        print(f"Using audio output device {device_idx}")

    # Set up audio output (don't start yet — PortAudio initializes COM as STA
    # which breaks bleak's WinRT backend; defer start to inside asyncio.run)
    audio_out = AudioOutput(device_index=device_idx)

    # Status display state
    last_status_time = [0.0]
    status_state = {
        "connection": "Idle",
        "battery": None,
        "gate": None,
    }

    def print_status() -> None:
        now = time.time()
        if now - last_status_time[0] < 1.0:
            return
        last_status_time[0] = now

        parts = [f"[{status_state['connection']}]"]
        if status_state["battery"]:
            pct, charging = status_state["battery"]
            parts.append(f"Batt: {pct}%{'⚡' if charging else ''}")
        if status_state["gate"]:
            parts.append(f"Gate: {status_state['gate']}")
        parts.append(
            f"Frames: {ble_client.frames} | "
            f"Muted: {ble_client.muted_frames} | "
            f"Lost: {ble_client.concealed_frames} | "
            f"Buf: {audio_out.buffer_depth}"
        )
        line = "  ".join(parts)
        print(f"\r{line:<100}", end="", flush=True)

    def on_audio(pcm: "np.ndarray") -> None:
        audio_out.enqueue(pcm)
        print_status()

    def on_status(event: str, data: object) -> None:
        if event in status_state:
            status_state[event] = data
        if event == "connection":
            print(f"\n>> {data}")

    ble_client = TossTalkBleClient(
        audio_cb=on_audio,
        status_cb=on_status,
        device_name=args.device_name,
    )

    # Build audio config if any tuning args were given
    audio_config = None
    if (
        args.gain is not None
        or args.noise_gate is not None
        or args.soft_limit is not None
    ):
        gain_q12 = round((args.gain if args.gain is not None else 5.0) * 4096)
        noise_gate = args.noise_gate if args.noise_gate is not None else 225
        soft_limit = args.soft_limit if args.soft_limit is not None else 18000
        audio_config = (gain_q12, noise_gate, soft_limit)
        print(
            f"Audio tuning: gain={args.gain if args.gain is not None else 5.0:.1f}x "
            f"gate={noise_gate} limit={soft_limit}"
        )

    async def run_bridge() -> None:
        """Async entry point — runs BLE client with clean shutdown on Ctrl+C."""
        # Start audio output inside the async context so that PortAudio's
        # COM initialization doesn't conflict with bleak's WinRT MTA requirement.
        try:
            audio_out.start()
        except Exception as e:
            print(f"ERROR: Failed to open audio output: {e}", file=sys.stderr)
            return

        loop = asyncio.get_running_loop()
        stop_event = asyncio.Event()

        if sys.platform == "win32":
            signal.signal(signal.SIGINT, lambda *_: stop_event.set())
        else:
            loop.add_signal_handler(signal.SIGINT, stop_event.set)

        # Send audio config once after first successful connect
        async def run_with_config() -> None:
            config_sent = False
            ble_client._running = True
            backoff = 1.0
            while ble_client._running:
                if not ble_client.is_connected:
                    ok = await ble_client.connect()
                    if not ok:
                        await asyncio.sleep(backoff)
                        backoff = min(backoff * 2, 30.0)
                        continue
                    backoff = 1.0
                    if audio_config and not config_sent:
                        await asyncio.sleep(0.5)  # let firmware finish settling
                        await ble_client.send_audio_config(*audio_config)
                        config_sent = True
                while ble_client._running and ble_client.is_connected:
                    await asyncio.sleep(0.5)
                if ble_client._running:
                    ble_client._reset_assembly()
                    await asyncio.sleep(1.0)

        if audio_config:
            ble_task = asyncio.create_task(run_with_config())
        else:
            ble_task = asyncio.create_task(ble_client.run())
        stop_task = asyncio.create_task(stop_event.wait())
        await asyncio.wait([ble_task, stop_task], return_when=asyncio.FIRST_COMPLETED)
        ble_client.stop()
        ble_task.cancel()
        try:
            await ble_task
        except asyncio.CancelledError:
            pass
        if ble_client.is_connected:
            await ble_client.disconnect()

    try:
        print("TossTalk Virtual Microphone Bridge")
        print("Press Ctrl+C to exit\n")
        asyncio.run(run_bridge())
    except KeyboardInterrupt:
        pass
    finally:
        print("\n\nShutting down...")
        audio_out.stop()
        print(
            f"Session stats: {ble_client.frames} frames, "
            f"{ble_client.muted_frames} muted, "
            f"{ble_client.concealed_frames} concealed, "
            f"{audio_out.underruns} underruns"
        )


if __name__ == "__main__":
    main()
