# Architecture

## Runtime model

Device is always hands-free.

State machine (`audio gate`):

- `UnmutedLive`
- `AirborneSuppressed`
- `ImpactLockout`
- `Reacquire`

Transitions are IMU-driven and biased toward fast talk recovery.

## Core components

- Firmware (XIAO ESP32 S3 Sense + MPU-6050)
  - IMU classifier (airborne/impact/recovery)
  - Audio capture + BLE uplink (near-live)
  - Auto-recover and reconnect loops
- Web PWA (desktop Chromium)
  - Web Bluetooth receiver
  - Audio playback pipeline
  - Device status view
  - Web Serial flashing UX
- Desktop bridge ([bridge/](../bridge/))
  - Python app that pipes BLE audio into a VB-Cable virtual microphone so Teams/Zoom/Discord can use TossTalk as a system mic
  - Tkinter GUI ([bridge/gui.py](../bridge/gui.py)) with connection control, live volume meter, battery + gate indicators, and live sliders that push gain / noise-gate / soft-limit changes to the firmware over the Control characteristic (no reboot required)
  - Headless CLI ([bridge/main.py](../bridge/main.py)) for scripted or packaged (`tosstalk-bridge.exe`) use
  - Dev launch: `uv run python -m bridge` (GUI) or `uv run python -m bridge.main` (CLI); see [bridge/README.md](../bridge/README.md) for setup

## Reliability posture

- Prioritize speech availability over perfect throw-noise suppression.
- Ambiguous motion should auto-recover; no user action needed.
- Internal logs only for tuning/debug.
