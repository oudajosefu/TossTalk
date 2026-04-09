# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TossTalk is a tossable wireless microphone built on the Seeed Studio XIAO ESP32 S3 Sense with an external GY-521 MPU-6050 IMU. It detects when thrown via IMU and automatically mutes throw noise, streaming audio to a browser-based web app over Bluetooth Low Energy (BLE).

Two components: **firmware** (C++/PlatformIO) and **web app** (vanilla JavaScript PWA, no build step).

## Python Environment (uv)

This project uses [uv](https://docs.astral.sh/uv/) as the recommended Python package manager. It is not strictly required — standard `pip` and `python` commands will also work — but `uv` provides faster installs and deterministic virtual environments.

```bash
# Install uv (if not already installed)
# See https://docs.astral.sh/uv/getting-started/installation/ for other methods
pip install uv # Or use scoop: `scoop install uv`

# Create a virtual environment in the repo root
uv venv

# Install Python dependencies (PlatformIO, esptool, bridge requirements)
uv run pip install platformio esptool
uv run pip install -r bridge/requirements.txt
```

## Build Commands

### Firmware

```bash
# Build firmware (from repo root)
cd firmware && pio run

# Create merged binary for web-serial flashing
cd .. && uv run python scripts/merge_firmware.py \
  --env-dir firmware/.pio/build/xiao-esp32s3 \
  --out web/firmware/tosstalk-merged.bin
```

> **Important:** After any firmware change that would require re-flashing the device, you must also re-run the merge script above so that the web UI uses the most up-to-date firmware matching your development environment.

### Web App

No build step. Serve the `web/` directory with any static HTTP server:

```bash
uv run python -m http.server -d web 8080
```

Requires desktop Chromium (Chrome or Edge) for Web Bluetooth and Web Serial APIs.

## Architecture

```
XIAO ESP32 S3 Sense + MPU-6050  Browser (Chrome/Edge)
┌──────────────────────┐        ┌──────────────────────┐
│ firmware/src/main.cpp│  BLE   │ web/core.js          │
│  PDM Mic → ADPCM     ├───────►│  Decode → Web Audio  │
│  MPU-6050 → Gate FSM │        │  Jitter buffer       │
│  BLE GATT server     │        │  Reconnection logic  │
└──────────────────────┘        │                      │
                                │ web/app.js           │
                                │  UI: volume meter,   │
                                │  gate state, battery │
                                │                      │
                                │ web/debug/app.js     │
                                │  Dev console + stats │
                                └──────────────────────┘
```

### Hardware Wiring

- **MPU-6050 (GY-521)**: 3V3→VCC, GND→GND, D4 (GPIO5)→SDA, D5 (GPIO6)→SCL
- **PDM Microphone**: Built-in on XIAO S3 Sense (GPIO42 CLK, GPIO41 DATA)
- **No display** — status output via Serial over USB-CDC
- **Battery**: Stubbed at 100% (no fuel gauge); BLE characteristic preserved for protocol compatibility

### Firmware (`firmware/src/main.cpp`)

Single monolithic file. Key subsystems:

- **Audio capture**: I2S PDM mic, 8 kHz, 160-sample frames (20ms), IMA ADPCM encoding (4:1 compression → 80 bytes/frame)
- **Motion gate FSM**: `UnmutedLive` → `AirborneSuppressed` (<0.35g freefall) → `ImpactLockout` (>2.20g, 120ms) → `Reacquire` (150ms) → `UnmutedLive`
- **BLE transmission**: Dual mode — single-packet (85 bytes, MTU≥88) or sub-packet (5×≤20 bytes, MTU<88)

### Web App (`web/`)

- **core.js**: Shared BLE engine, ADPCM decoder, jitter buffer (target 4 frames / 120ms latency), Web Audio playback (48 kHz output), reconnection with backoff, firmware flashing via esptool-js
- **app.js**: Main UI — connection button, volume ring meter (RMS-based), gate state display, battery indicator
- **sw.js**: Service worker, network-first caching strategy, cache version `tosstalk-v20`
- **debug/**: Alternative UI showing raw stats (frame counts, drops, sub-packets) and advanced flashing options

### BLE Protocol

Service UUID: `9f8d0001-6b7b-4f26-b10f-3aa861aa0001`

| Characteristic | UUID suffix | Direction   | Purpose                    |
| -------------- | ----------- | ----------- | -------------------------- |
| Audio          | `...0002`   | Notify      | Compressed audio frames    |
| Battery        | `...0003`   | Read/Notify | Percentage + charging flag |
| State          | `...0004`   | Read/Notify | Gate state enum (0-3)      |
| Control        | `...0005`   | Write       | Commands (e.g., "ping")    |

Full protocol spec: `docs/ble-protocol.md`

### Key Constants (firmware)

| Constant           | Value              | Purpose                                    |
| ------------------ | ------------------ | ------------------------------------------ |
| Sample rate        | 8000 Hz            | Mic capture rate                           |
| Frame size         | 160 samples (20ms) | Audio frame duration                       |
| Ring buffer        | 4 frames           | Mic data queue depth                       |
| Noise gate         | threshold 96       | Silence suppression                        |
| Soft limiter       | peak 12000         | Adaptive compression                       |
| Input trim         | 0.75× (Q10: 768)   | Gain reduction                             |
| Mic magnification  | 6×                 | Capture gain (may need tuning for PDM mic) |
| Airborne threshold | <0.35g             | Freefall detection                         |
| Impact threshold   | >2.20g             | Catch detection                            |
| Lockout duration   | 120ms              | Post-impact mute                           |
| Reacquire duration | 150ms              | Recovery grace period                      |
| BLE settle window  | 3500ms             | Post-connect service discovery delay       |

## CI/CD

Two GitHub Actions workflows:

- **firmware.yml**: Builds firmware on push to `main` or PR. Uploads build artifacts.
- **pages.yml**: Builds firmware, runs merge script, generates firmware metadata (SHA256, size, timestamp), deploys `web/` to GitHub Pages.

## Dependencies

### Firmware (PlatformIO)

- **NimBLE-Arduino** 1.4.2 — BLE stack (GATT server, notifications)
- **Adafruit MPU6050** 2.2.6 — IMU driver for GY-521 (I2C)
- **ESP-IDF I2S driver** (`driver/i2s.h`) — PDM microphone capture

### Web

- **esptool-js** 0.5.6 (loaded from CDN) — browser-based ESP32 flashing
- No npm dependencies, no bundler, no build tooling

## Testing

No automated test suite. Testing requires:

- Physical XIAO ESP32 S3 Sense + GY-521 MPU-6050 hardware
- Desktop Chrome or Edge browser
- `docs/test-plan.md` describes the manual test approach

## Documentation

Additional docs in `docs/`:

- `architecture.md` — runtime model and state machine details
- `ble-protocol.md` — full BLE service/characteristic spec and frame formats
- `flashing-web-serial.md` — Web Serial flashing implementation
- `observability.md` — logging strategy
- `milestones.md` — project milestones
