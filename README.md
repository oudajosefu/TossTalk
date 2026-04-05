# TossTalk

TossTalk is a tossable wireless microphone built on the Seeed Studio XIAO ESP32 S3 Sense with an external GY-521 MPU-6050 IMU.

Power it on, pair it, and pass it around whenever a group needs one shared mic.

Original build guide (M5StickC Plus2 version): [TossTalk on Instructables](https://www.instructables.com/TossTalk-Build-an-Inexpensive-Tossable-Rollable-Wi/)

## What it does

- Detects when the device is in the air and mutes throw noise
- Recovers quickly so the next speaker can talk right after catching it
- Streams audio to a web app over BLE
- Plays audio through connected speakers
- Supports browser-based firmware updates without the Arduino IDE

## Quick start

1. Power on TossTalk
2. Open the TossTalk web page in Chrome or Edge (desktop) at [oudajosefu.github.io/TossTalk/web](https://oudajosefu.github.io/TossTalk/web)
3. Connect the device
4. Pass or toss the mic to whoever needs to speak

Normal reconnect and recovery are automatic.

## Firmware updates (easy path)

The web app includes a Flash Firmware button that uses Web Serial in Chromium browsers.

By default, it flashes a prebuilt merged image hosted with the site:

- [web/firmware/tosstalk-merged.bin](web/firmware/tosstalk-merged.bin)

This file is generated automatically by GitHub Actions during deployment.

## Browser support

- Target: Desktop Chromium browsers (Chrome, Edge)
- Mobile browsers: not currently in scope

## Project structure

- [firmware](firmware): Device firmware (PlatformIO)
- [web](web): Browser app (PWA + Web Bluetooth + Web Serial flashing)
- [docs](docs): Architecture, protocol, milestones, test notes
- [.github/workflows](.github/workflows): Build and deployment automation

## For developers

### Python environment (uv)

This project uses [uv](https://docs.astral.sh/uv/) as the recommended Python package manager. It is not strictly required — standard `pip` and `python` commands will also work — but `uv` provides faster installs and deterministic virtual environments.

```bash
# Install uv (if not already installed)
# See https://docs.astral.sh/uv/getting-started/installation/ for other methods
pip install uv

# Create a virtual environment in the repo root
uv venv

# Install Python dependencies (PlatformIO, esptool, bridge requirements)
uv run pip install platformio esptool
uv run pip install -r bridge/requirements.txt
```

### Local firmware build

1. Open [firmware/platformio.ini](firmware/platformio.ini)
2. Build/upload with PlatformIO

> **Important:** After any firmware change that would require re-flashing the device, you must also re-run the merge script so the web UI uses the most up-to-date firmware:
>
> ```bash
> uv run python scripts/merge_firmware.py \
>   --env-dir firmware/.pio/build/xiao-esp32s3 \
>   --out web/firmware/tosstalk-merged.bin
> ```

### Local web testing

Serve [web](web) with any static server and open in desktop Chromium:

```bash
uv run python -m http.server -d web 8080
```

### Deployment

Push to `main` to:

- deploy the web app to GitHub Pages
- build firmware
- publish updated merged firmware for browser flashing
