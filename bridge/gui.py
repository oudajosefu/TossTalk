"""TossTalk Bridge GUI — Tkinter frontend.

Runs the Tk event loop on the main thread and hosts the asyncio loop,
BLE client, and audio output on a dedicated worker thread so that COM
apartment requirements don't conflict (bleak/WinRT wants MTA, PortAudio
initializes STA).
"""

from __future__ import annotations

import asyncio
import logging
import queue
import sys
import threading
import tkinter as tk
from tkinter import ttk

import numpy as np

log = logging.getLogger(__name__)


# ── Worker thread ────────────────────────────────────────────────────────────


class BridgeWorker:
    """Owns the asyncio loop, BLE client, and audio output on a worker thread.

    The GUI talks to this class from the Tk main thread; everything here is
    thread-safe. Coroutines are scheduled with asyncio.run_coroutine_threadsafe.
    """

    def __init__(self, event_queue: "queue.Queue[tuple[str, object]]") -> None:
        self._event_queue = event_queue
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._ready = threading.Event()

        # Populated on the worker thread after imports
        self._AudioOutput = None
        self._find_vb_cable = None
        self._list_devices_fn = None
        self._audio_out = None
        self._ble_client = None
        self._ble_task: asyncio.Task | None = None

        self._device_name = "TossTalk"

    # ── lifecycle ────────────────────────────────────────────────────────────

    def start(self) -> None:
        self._thread = threading.Thread(
            target=self._run_thread, name="bridge-worker", daemon=True
        )
        self._thread.start()
        if not self._ready.wait(timeout=10.0):
            raise RuntimeError("Bridge worker failed to start")

    def _run_thread(self) -> None:
        # Force COM to MTA before any library (bleak/WinRT) initializes it
        # on this thread. Must happen before importing audio_output (sounddevice).
        if sys.platform == "win32":
            import ctypes

            ctypes.windll.ole32.CoInitializeEx(0, 0x0)  # COINIT_MULTITHREADED

        try:
            from .audio_output import (
                AudioOutput,
                find_vb_cable_device,
                list_output_devices,
            )
            from .ble_client import TossTalkBleClient
        except ImportError:
            from audio_output import (
                AudioOutput,
                find_vb_cable_device,
                list_output_devices,
            )
            from ble_client import TossTalkBleClient

        self._AudioOutput = AudioOutput
        self._find_vb_cable = find_vb_cable_device
        self._list_devices_fn = list_output_devices
        self._TossTalkBleClient = TossTalkBleClient

        device_idx = find_vb_cable_device()
        self._audio_out = AudioOutput(device_index=device_idx)

        def on_audio(pcm: np.ndarray) -> None:
            try:
                if self._audio_out is not None:
                    self._audio_out.enqueue(pcm)
            except Exception:
                log.exception("audio enqueue failed")
            if pcm.size:
                rms = float(np.sqrt(np.mean(pcm.astype(np.float64) ** 2)) / 32768.0)
            else:
                rms = 0.0
            self._event_queue.put(("audio", rms))
            if self._ble_client is not None and self._audio_out is not None:
                self._event_queue.put(
                    (
                        "stats",
                        {
                            "frames": self._ble_client.frames,
                            "muted": self._ble_client.muted_frames,
                            "lost": self._ble_client.concealed_frames,
                            "buffer": self._audio_out.buffer_depth,
                            "underruns": self._audio_out.underruns,
                        },
                    )
                )

        def on_status(event: str, data: object) -> None:
            self._event_queue.put((event, data))

        self._ble_client = TossTalkBleClient(
            audio_cb=on_audio,
            status_cb=on_status,
            device_name=self._device_name,
        )

        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)

        # Start the audio output from inside the worker thread so that
        # PortAudio's per-thread COM init lands on this thread, not main.
        try:
            self._audio_out.start()
            self._event_queue.put(("log", "Audio output started"))
        except Exception as e:
            log.exception("audio_out.start failed")
            self._event_queue.put(("log", f"Audio output failed: {e}"))

        self._ready.set()
        try:
            self._loop.run_forever()
        finally:
            try:
                if self._audio_out is not None:
                    self._audio_out.stop()
            except Exception:
                pass
            self._loop.close()

    def shutdown(self) -> None:
        if self._loop is None:
            return
        fut = self._submit(self._stop_ble_run())
        try:
            if fut is not None:
                fut.result(timeout=3.0)
        except Exception:
            pass
        self._loop.call_soon_threadsafe(self._loop.stop)
        if self._thread is not None:
            self._thread.join(timeout=3.0)

    # ── queries (main-thread safe) ───────────────────────────────────────────

    def list_output_devices(self) -> list[tuple[int, str]]:
        return self._list_devices_fn() if self._list_devices_fn else []

    def find_vb_cable(self) -> int | None:
        return self._find_vb_cable() if self._find_vb_cable else None

    def set_device_name(self, name: str) -> None:
        self._device_name = name
        if self._ble_client is not None:
            self._ble_client.device_name = name

    # ── commands ─────────────────────────────────────────────────────────────

    def connect(self) -> None:
        self._submit(self._start_ble_run())

    def disconnect(self) -> None:
        self._submit(self._stop_ble_run())

    def send_config(self, gain_q12: int, gate: int, limit: int) -> None:
        self._submit(self._send_config(gain_q12, gate, limit))

    def send_sleep(self) -> None:
        self._submit(self._send_sleep())

    def set_output_device(self, device_index: int) -> None:
        self._submit(self._swap_audio_device(device_index))

    # ── internals (worker-thread coroutines) ─────────────────────────────────

    def _submit(self, coro):
        if self._loop is None:
            return None
        return asyncio.run_coroutine_threadsafe(coro, self._loop)

    async def _start_ble_run(self) -> None:
        if self._ble_client is None:
            return
        if self._ble_task is not None and not self._ble_task.done():
            return
        self._ble_task = asyncio.create_task(self._ble_client.run())

    async def _stop_ble_run(self) -> None:
        if self._ble_client is not None:
            self._ble_client.stop()
        if self._ble_task is not None and not self._ble_task.done():
            self._ble_task.cancel()
            try:
                await self._ble_task
            except (asyncio.CancelledError, Exception):
                pass
        self._ble_task = None
        if self._ble_client is not None and self._ble_client.is_connected:
            try:
                await self._ble_client.disconnect()
            except Exception:
                pass

    async def _send_config(self, gain_q12: int, gate: int, limit: int) -> None:
        if self._ble_client is None or not self._ble_client.is_connected:
            self._event_queue.put(("log", "Cannot send tuning: not connected"))
            return
        await self._ble_client.send_audio_config(gain_q12, gate, limit)

    async def _send_sleep(self) -> None:
        if self._ble_client is None or not self._ble_client.is_connected:
            self._event_queue.put(("log", "Cannot send sleep: not connected"))
            return
        await self._ble_client.send_sleep()
        # Stop the auto-reconnect loop so we don't wake the device back up
        await self._stop_ble_run()

    async def _swap_audio_device(self, device_index: int) -> None:
        if self._AudioOutput is None:
            return
        try:
            if self._audio_out is not None:
                self._audio_out.stop()
        except Exception:
            pass
        self._audio_out = self._AudioOutput(device_index=device_index)
        try:
            self._audio_out.start()
            self._event_queue.put(("log", f"Switched to audio device {device_index}"))
        except Exception as e:
            self._event_queue.put(("log", f"Failed to open device {device_index}: {e}"))


# ── Log routing ──────────────────────────────────────────────────────────────


class _QueueLogHandler(logging.Handler):
    """Routes log records into the GUI event queue."""

    def __init__(self, q: "queue.Queue[tuple[str, object]]") -> None:
        super().__init__()
        self._q = q

    def emit(self, record: logging.LogRecord) -> None:
        try:
            msg = self.format(record)
            self._q.put(("log", msg))
        except Exception:
            pass


# ── GUI ──────────────────────────────────────────────────────────────────────


class BridgeGui:
    """Tkinter frontend for the TossTalk bridge."""

    GATE_COLORS = {
        "UnmutedLive": "#2e7d32",
        "AirborneSuppressed": "#f9a825",
        "ImpactLockout": "#c62828",
        "Reacquire": "#1565c0",
    }

    def __init__(self) -> None:
        self._event_queue: "queue.Queue[tuple[str, object]]" = queue.Queue()
        self._worker = BridgeWorker(self._event_queue)
        self._device_list: list[tuple[int, str]] = []

        self._root = tk.Tk()
        self._root.title("TossTalk Bridge")
        self._root.geometry("540x680")
        self._root.minsize(500, 620)

        self._build_ui()

        # Route logs into GUI log pane
        handler = _QueueLogHandler(self._event_queue)
        handler.setFormatter(
            logging.Formatter(
                "%(asctime)s %(levelname)-5s %(name)s: %(message)s",
                datefmt="%H:%M:%S",
            )
        )
        handler.setLevel(logging.INFO)
        logging.getLogger().addHandler(handler)

        self._worker.start()
        self._populate_devices()
        self._root.after(50, self._drain_events)
        self._root.protocol("WM_DELETE_WINDOW", self._on_close)

    # ── layout ───────────────────────────────────────────────────────────────

    def _build_ui(self) -> None:
        # Connection
        conn = ttk.LabelFrame(self._root, text="Connection")
        conn.pack(fill="x", padx=8, pady=4)

        row1 = ttk.Frame(conn)
        row1.pack(fill="x", padx=6, pady=4)
        ttk.Label(row1, text="Device name:").pack(side="left")
        self._device_name_var = tk.StringVar(value="TossTalk")
        ttk.Entry(row1, textvariable=self._device_name_var, width=18).pack(
            side="left", padx=6
        )

        row2 = ttk.Frame(conn)
        row2.pack(fill="x", padx=6, pady=4)
        ttk.Label(row2, text="Status:").pack(side="left")
        self._status_var = tk.StringVar(value="Idle")
        ttk.Label(row2, textvariable=self._status_var, foreground="#555").pack(
            side="left", padx=4
        )
        ttk.Button(row2, text="Power Off", command=self._on_sleep).pack(
            side="right", padx=4
        )
        ttk.Button(row2, text="Disconnect", command=self._on_disconnect).pack(
            side="right", padx=4
        )
        ttk.Button(row2, text="Connect", command=self._on_connect).pack(side="right")

        # Device info
        info = ttk.LabelFrame(self._root, text="Device")
        info.pack(fill="x", padx=8, pady=4)
        info_row = ttk.Frame(info)
        info_row.pack(fill="x", padx=6, pady=4)
        ttk.Label(info_row, text="Battery:").pack(side="left")
        self._battery_var = tk.StringVar(value="—")
        ttk.Label(info_row, textvariable=self._battery_var, width=10).pack(
            side="left", padx=4
        )
        ttk.Label(info_row, text="Gate:").pack(side="left", padx=(12, 0))
        self._gate_var = tk.StringVar(value="—")
        self._gate_label = ttk.Label(
            info_row, textvariable=self._gate_var, foreground="#555"
        )
        self._gate_label.pack(side="left", padx=4)

        # Audio output device
        out = ttk.LabelFrame(self._root, text="Audio output")
        out.pack(fill="x", padx=8, pady=4)
        out_row = ttk.Frame(out)
        out_row.pack(fill="x", padx=6, pady=4)
        self._device_var = tk.StringVar()
        self._device_combo = ttk.Combobox(
            out_row, textvariable=self._device_var, state="readonly"
        )
        self._device_combo.pack(side="left", fill="x", expand=True)
        ttk.Button(out_row, text="Apply", command=self._on_apply_device).pack(
            side="right", padx=4
        )

        # Volume meter
        vol = ttk.LabelFrame(self._root, text="Volume")
        vol.pack(fill="x", padx=8, pady=4)
        self._volume_var = tk.DoubleVar(value=0.0)
        ttk.Progressbar(vol, variable=self._volume_var, maximum=1.0).pack(
            fill="x", padx=6, pady=6
        )

        # Stats
        stats = ttk.LabelFrame(self._root, text="Stats")
        stats.pack(fill="x", padx=8, pady=4)
        sg = ttk.Frame(stats)
        sg.pack(padx=6, pady=4)
        self._stats_vars: dict[str, tk.StringVar] = {}
        labels = [
            ("frames", "Frames"),
            ("muted", "Muted"),
            ("lost", "Lost"),
            ("buffer", "Buffer"),
            ("underruns", "Underruns"),
        ]
        for i, (key, label) in enumerate(labels):
            col = ttk.Frame(sg)
            col.grid(row=0, column=i, padx=8)
            ttk.Label(col, text=label, foreground="#888").pack()
            var = tk.StringVar(value="0")
            ttk.Label(col, textvariable=var, font=("TkDefaultFont", 10, "bold")).pack()
            self._stats_vars[key] = var

        # Tuning
        tune = ttk.LabelFrame(self._root, text="Audio tuning (live)")
        tune.pack(fill="x", padx=8, pady=4)
        self._gain_var = tk.DoubleVar(value=5.0)
        self._gate_slider_var = tk.DoubleVar(value=216.0)
        self._limit_var = tk.DoubleVar(value=18000.0)
        self._make_slider(
            tune,
            "Gain",
            self._gain_var,
            0.0,
            20.0,
            lambda: f"{self._gain_var.get():.1f}x",
        )
        self._make_slider(
            tune,
            "Noise gate",
            self._gate_slider_var,
            0.0,
            2000.0,
            lambda: f"{int(self._gate_slider_var.get())}",
        )
        self._make_slider(
            tune,
            "Soft limit",
            self._limit_var,
            1000.0,
            32767.0,
            lambda: f"{int(self._limit_var.get())}",
        )

        # Log pane
        log_frame = ttk.LabelFrame(self._root, text="Log")
        log_frame.pack(fill="both", expand=True, padx=8, pady=4)
        self._log_text = tk.Text(
            log_frame,
            height=8,
            wrap="none",
            state="disabled",
            font=("Consolas", 9),
        )
        self._log_text.pack(fill="both", expand=True, padx=6, pady=4)

    def _make_slider(self, parent, label, var, lo, hi, fmt) -> None:
        row = ttk.Frame(parent)
        row.pack(fill="x", padx=6, pady=2)
        ttk.Label(row, text=label, width=12).pack(side="left")
        value_label = ttk.Label(row, text=fmt(), width=8, anchor="e")
        value_label.pack(side="right")

        def on_change(*_args) -> None:
            value_label.configure(text=fmt())

        def on_release(_evt=None) -> None:
            value_label.configure(text=fmt())
            self._push_config()

        scale = ttk.Scale(
            row,
            from_=lo,
            to=hi,
            variable=var,
            orient="horizontal",
            command=on_change,
        )
        scale.pack(side="left", fill="x", expand=True, padx=6)
        scale.bind("<ButtonRelease-1>", on_release)

    def _populate_devices(self) -> None:
        devices = self._worker.list_output_devices()
        self._device_list = devices
        self._device_combo["values"] = [f"[{i}] {n}" for i, n in devices]
        vb = self._worker.find_vb_cable()
        if vb is not None:
            for i, (idx, _name) in enumerate(devices):
                if idx == vb:
                    self._device_combo.current(i)
                    break
        elif devices:
            self._device_combo.current(0)

    # ── button handlers ──────────────────────────────────────────────────────

    def _on_connect(self) -> None:
        name = self._device_name_var.get().strip() or "TossTalk"
        self._worker.set_device_name(name)
        self._worker.connect()
        self._status_var.set("Starting...")

    def _on_disconnect(self) -> None:
        self._worker.disconnect()
        self._status_var.set("Stopping...")

    def _on_sleep(self) -> None:
        from tkinter import messagebox

        if not messagebox.askokcancel(
            "Power Off",
            "Power off the microphone?\nPress the BOOT button on the device to wake it.",
        ):
            return
        self._worker.send_sleep()
        self._status_var.set("Sleep sent")

    def _on_apply_device(self) -> None:
        sel = self._device_combo.current()
        if sel < 0 or sel >= len(self._device_list):
            return
        idx, _name = self._device_list[sel]
        self._worker.set_output_device(idx)

    def _push_config(self) -> None:
        gain_q12 = int(round(self._gain_var.get() * 4096))
        gate = int(round(self._gate_slider_var.get()))
        limit = int(round(self._limit_var.get()))
        self._worker.send_config(gain_q12, gate, limit)

    # ── event drain ──────────────────────────────────────────────────────────

    def _drain_events(self) -> None:
        try:
            while True:
                evt, data = self._event_queue.get_nowait()
                self._handle_event(evt, data)
        except queue.Empty:
            pass
        # Decay the volume meter so silence visibly drops the bar
        self._volume_var.set(self._volume_var.get() * 0.85)
        self._root.after(50, self._drain_events)

    def _handle_event(self, evt: str, data: object) -> None:
        if evt == "connection":
            self._status_var.set(str(data))
        elif evt == "battery":
            if isinstance(data, tuple) and len(data) == 2:
                pct, charging = data
                self._battery_var.set(f"{pct}%{' ⚡' if charging else ''}")
        elif evt == "gate":
            name = str(data)
            self._gate_var.set(name)
            color = self.GATE_COLORS.get(name, "#555")
            try:
                self._gate_label.configure(foreground=color)
            except Exception:
                pass
        elif evt == "audio":
            cur = self._volume_var.get()
            new = max(cur, float(data))  # type: ignore[arg-type]
            self._volume_var.set(min(new, 1.0))
        elif evt == "stats":
            if isinstance(data, dict):
                for k, v in data.items():
                    if k in self._stats_vars:
                        self._stats_vars[k].set(str(v))
        elif evt == "log":
            self._append_log(str(data))

    def _append_log(self, line: str) -> None:
        try:
            self._log_text.configure(state="normal")
            self._log_text.insert("end", line + "\n")
            linecount = int(self._log_text.index("end-1c").split(".")[0])
            if linecount > 500:
                self._log_text.delete("1.0", f"{linecount - 500}.0")
            self._log_text.see("end")
            self._log_text.configure(state="disabled")
        except Exception:
            pass

    # ── lifecycle ────────────────────────────────────────────────────────────

    def _on_close(self) -> None:
        try:
            self._worker.shutdown()
        finally:
            self._root.destroy()

    def run(self) -> None:
        self._root.mainloop()


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-5s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    BridgeGui().run()


if __name__ == "__main__":
    main()
