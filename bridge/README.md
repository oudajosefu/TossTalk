# TossTalk Virtual Microphone Bridge

A Windows desktop app that connects to a TossTalk BLE device and streams its audio to a virtual microphone, so apps like Microsoft Teams, Zoom, and Discord can use it as a mic input.

## How It Works

```
TossTalk (BLE)  →  bridge.exe (decode ADPCM, resample 8→48 kHz)  →  VB-Cable  →  Teams/Zoom
```

The bridge connects to the TossTalk device over Bluetooth Low Energy, decodes the IMA ADPCM audio stream, resamples it from 8 kHz to 48 kHz, and writes the PCM audio into a VB-Cable virtual audio device. Any app that can select an audio input will see VB-Cable as a microphone.

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
cd bridge

# Using uv (recommended)
uv run pip install -r requirements.txt
uv run python -m bridge.main

# Or using standard pip/python
pip install -r requirements.txt
python -m bridge.main
```

## Usage

1. Power on your TossTalk device
2. Run the bridge:

   ```bash
   # Auto-detect VB-Cable and TossTalk device
   tosstalk-bridge.exe

   # Or from source
   uv run python -m bridge.main
   ```

3. The bridge will scan for the TossTalk device, connect, and start streaming audio.

4. In **Microsoft Teams** (or other app):
   - Go to **Settings → Devices → Audio devices**
   - Set **Microphone** to **CABLE Output (VB-Audio Virtual Cable)**
   - The TossTalk audio will now be used as your mic input

### Command-line options

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

The output will be in `dist/tosstalk-bridge.exe`.
