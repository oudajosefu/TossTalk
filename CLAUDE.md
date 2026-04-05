# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TossTalk is a tossable wireless microphone built on the M5StickC Plus2 (ESP32-PICO). It detects when thrown via IMU and automatically mutes throw noise, streaming audio to a browser-based web app over Bluetooth Low Energy (BLE).

Two components: **firmware** (C++/PlatformIO) and **web app** (vanilla JavaScript PWA, no build step).

## Build Commands

### Firmware

```bash
# Install tools
pip install platformio esptool

# Build firmware (from repo root)
cd firmware && pio run

# Create merged binary for web-serial flashing
python scripts/merge_firmware.py
# Output: web/firmware/tosstalk-merged.bin
```

### Web App

No build step. Serve the `web/` directory with any static HTTP server:

```bash
python -m http.server -d web 8080
```

Requires desktop Chromium (Chrome or Edge) for Web Bluetooth and Web Serial APIs.

## Architecture

```
M5StickC Plus2 (ESP32)          Browser (Chrome/Edge)
┌──────────────────────┐        ┌──────────────────────┐
│ firmware/src/main.cpp│  BLE   │ web/core.js          │
│  Mic → ADPCM encode ├───────►│  Decode → Web Audio  │
│  IMU → Gate FSM      │        │  Jitter buffer       │
│  BLE GATT server     │        │  Reconnection logic  │
│  Battery monitoring  │        │                      │
└──────────────────────┘        │ web/app.js           │
                                │  UI: volume meter,   │
                                │  gate state, battery │
                                │                      │
                                │ web/debug/app.js     │
                                │  Dev console + stats │
                                └──────────────────────┘
```

### Firmware (`firmware/src/main.cpp`)

Single monolithic file. Key subsystems:

- **Audio capture**: 8 kHz, 160-sample frames (20ms), IMA ADPCM encoding (4:1 compression → 80 bytes/frame)
- **Motion gate FSM**: `UnmutedLive` → `AirborneSuppressed` (<0.35g freefall) → `ImpactLockout` (>2.20g, 120ms) → `Reacquire` (150ms) → `UnmutedLive`
- **BLE transmission**: Dual mode — single-packet (85 bytes, MTU≥88) or sub-packet (5×≤20 bytes, MTU<88)
- **Battery HUD**: EMA-smoothed percentage on display, throttled updates
- **Display**: Throttled to 500ms during streaming to avoid blocking audio

### Web App (`web/`)

- **core.js**: Shared BLE engine, ADPCM decoder, jitter buffer (target 4 frames / 120ms latency), Web Audio playback (48 kHz output), reconnection with backoff, firmware flashing via esptool-js
- **app.js**: Main UI — connection button, volume ring meter (RMS-based), gate state display, battery indicator
- **sw.js**: Service worker, network-first caching strategy, cache version `tosstalk-v20`
- **debug/**: Alternative UI showing raw stats (frame counts, drops, sub-packets) and advanced flashing options

### BLE Protocol

Service UUID: `9f8d0001-6b7b-4f26-b10f-3aa861aa0001`

| Characteristic | UUID suffix | Direction | Purpose |
|---|---|---|---|
| Audio | `...0002` | Notify | Compressed audio frames |
| Battery | `...0003` | Read/Notify | Percentage + charging flag |
| State | `...0004` | Read/Notify | Gate state enum (0–3) |
| Control | `...0005` | Write | Commands (e.g., "ping") |

Full protocol spec: `docs/ble-protocol.md`

### Key Constants (firmware)

| Constant | Value | Purpose |
|---|---|---|
| Sample rate | 8000 Hz | Mic capture rate |
| Frame size | 160 samples (20ms) | Audio frame duration |
| Ring buffer | 4 frames | Mic data queue depth |
| Noise gate | threshold 96 | Silence suppression |
| Soft limiter | peak 12000 | Adaptive compression |
| Input trim | 0.75× (Q10: 768) | Gain reduction |
| Mic magnification | 6× | Capture gain |
| Airborne threshold | <0.35g | Freefall detection |
| Impact threshold | >2.20g | Catch detection |
| Lockout duration | 120ms | Post-impact mute |
| Reacquire duration | 150ms | Recovery grace period |
| BLE settle window | 3500ms | Post-connect service discovery delay |

## CI/CD

Two GitHub Actions workflows:

- **firmware.yml**: Builds firmware on push to `main` or PR. Uploads build artifacts.
- **pages.yml**: Builds firmware, runs merge script, generates firmware metadata (SHA256, size, timestamp), deploys `web/` to GitHub Pages.

## Dependencies

### Firmware (PlatformIO)
- **M5Unified** 0.2.2 — HAL for M5StickC Plus2 (display, IMU, mic, power)
- **NimBLE-Arduino** 1.4.2 — BLE stack (GATT server, notifications)

### Web
- **esptool-js** 0.5.6 (loaded from CDN) — browser-based ESP32 flashing
- No npm dependencies, no bundler, no build tooling

## Testing

No automated test suite. Testing requires:
- Physical M5StickC Plus2 hardware
- Desktop Chrome or Edge browser
- `docs/test-plan.md` describes the manual test approach

## Documentation

Additional docs in `docs/`:
- `architecture.md` — runtime model and state machine details
- `ble-protocol.md` — full BLE service/characteristic spec and frame formats
- `flashing-web-serial.md` — Web Serial flashing implementation
- `observability.md` — logging strategy
- `milestones.md` — project milestones
