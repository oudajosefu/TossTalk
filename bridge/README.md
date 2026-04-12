# TossTalk Virtual Microphone Bridge

A Windows desktop app that connects to a TossTalk BLE device and streams its audio to a virtual microphone, so apps like Microsoft Teams, Zoom, and Discord can use it as a mic input.

## How It Works

```
TossTalk (BLE)  →  bridge (decode ADPCM, resample 8→48 kHz)  →  VB-Cable  →  Teams/Zoom
```

The bridge connects to the TossTalk device over Bluetooth Low Energy, decodes the IMA ADPCM audio stream, resamples it from 8 kHz to 48 kHz, and writes the PCM audio into a VB-Cable virtual audio device. Any app that can select an audio input will see VB-Cable as a microphone.

The bridge ships in two flavors:

- **GUI** (Tkinter, stdlib only) — the default. A desktop window with a connect/disconnect button, live volume meter, battery + gate indicators, stats, output-device picker, and live sliders for gain / noise gate / soft limit that push to the device over BLE while you drag.
- **CLI** — headless console app configured via flags. Used by the packaged `tosstalk-bridge.exe` and for scripted / server setups.

## Prerequisites

1. **VB-Cable** — Free virtual audio cable driver
   - Download from [https://vb-audio.com/Cable/](https://vb-audio.com/Cable/)
   - Run the installer **as Administrator**
   - **Reboot** after installation
   - After reboot, "CABLE Input" should appear in your audio devices

2. **Windows 10/11** with Bluetooth Low Energy support

## Installation

### From packaged .exe (recommended)

Download `tosstalk-bridge.exe` from the latest release and run it. No Python required.

### From source

```bash
# From the repo root, using uv (recommended)
uv pip install -r bridge/requirements.txt

# Launch the GUI (default)
uv run python -m bridge

# Or launch the CLI
uv run python -m bridge.main
```

Standard `pip` and `python` work too if you don't want uv — just drop the `uv run` prefix. Tkinter is bundled with Python on Windows, so no extra install step is needed for the GUI.

## Usage

### GUI (recommended for development)

1. Power on your TossTalk device
2. Launch the GUI:

   ```bash
   uv run python -m bridge
   ```

3. The window opens with the output device dropdown pre-populated (VB-Cable auto-selected if installed).
4. Click **Connect**. Status walks Scanning → Connecting → Waiting for device to settle → Connected. Battery and gate indicators populate; the volume meter responds to speech.
5. Drag the **Gain**, **Noise gate**, or **Soft limit** sliders — values are pushed to the firmware on mouse release via the Control characteristic, so you can tune audio live without rebooting the device.
6. In **Microsoft Teams** (or other app):
   - Go to **Settings → Devices → Audio devices**
   - Set **Microphone** to **CABLE Output (VB-Audio Virtual Cable)**
   - The TossTalk audio will now be used as your mic input

Close the window to disconnect cleanly.

### CLI

The CLI is the headless path used by the packaged `.exe` and by scripted setups:

```bash
# Auto-detect VB-Cable and TossTalk device
tosstalk-bridge.exe

# Or from source
uv run python -m bridge.main
```

It scans for the TossTalk device, connects, and streams to the one-line status view in the terminal. Tuning params are supplied via flags and require a restart to change.

### Command-line options (CLI only)

```
tosstalk-bridge.exe [options]

  --device-name NAME    BLE device name to scan for (default: TossTalk)
  --output-device IDX   Audio output device index (bypass VB-Cable auto-detect)
  --list-devices        List available audio output devices and exit
  --scan-timeout SEC    BLE scan timeout in seconds (default: 10)
  -v, --verbose         Enable debug logging
```

### List audio devices

```bash
tosstalk-bridge.exe --list-devices
```

This shows all output devices with their index numbers. Look for `CABLE Input` (the VB-Cable device).

## Troubleshooting

### "VB-Cable not found"

- Make sure VB-Cable is installed and you've rebooted
- Run `--list-devices` to check if it appears
- If the device name is different, use `--output-device <index>`

### "Device not found" during BLE scan

- Make sure the TossTalk device is powered on and not connected to another client (the web app)
- Try increasing `--scan-timeout 30`
- Move closer to the device

### No audio in Teams

- In Windows Sound Settings, make sure "CABLE Output" is not disabled
- In Teams, explicitly select "CABLE Output (VB-Audio Virtual Cable)" as the microphone
- Restart Teams after installing VB-Cable

### Audio is choppy

- Move closer to the TossTalk device (BLE range)
- Close the TossTalk web app if it's open (only one BLE client at a time)
- Check the buffer depth in the console — if it's consistently 0, there's a BLE throughput issue

## Building the .exe

```bash
pip install pyinstaller
pyinstaller bridge/tosstalk-bridge.spec
```

The output will be in `dist/tosstalk-bridge.exe`. The packaged exe currently wraps the CLI entry point ([bridge/main.py](main.py)) — the GUI is intended for local development via `python -m bridge`.

## Module layout

- [bridge/gui.py](gui.py) — Tkinter GUI. Runs Tk on the main thread and hosts the asyncio loop + BLE client + audio output on a dedicated worker thread (MTA COM init on Windows so `bleak`'s WinRT backend and PortAudio's STA stream coexist).
- [bridge/main.py](main.py) — CLI entry point. Preserved unchanged so the PyInstaller build and scripted use keep working.
- [bridge/ble_client.py](ble_client.py) — `TossTalkBleClient`: BLE scan, connect, notifications, ADPCM frame reassembly, auto-reconnect.
- [bridge/audio_output.py](audio_output.py) — `AudioOutput`: 8 kHz → 48 kHz resample, jitter buffer, `sounddevice` stream.
- [bridge/adpcm.py](adpcm.py) — IMA ADPCM decoder.
