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

- Firmware (M5StickC Plus2)
  - IMU classifier (airborne/impact/recovery)
  - Audio capture + BLE uplink (near-live)
  - Battery HUD (always visible)
  - Auto-recover and reconnect loops
- Web PWA (desktop Chromium)
  - Web Bluetooth receiver
  - Audio playback pipeline
  - Device status view
  - Web Serial flashing UX

## Reliability posture

- Prioritize speech availability over perfect throw-noise suppression.
- Ambiguous motion should auto-recover; no user action needed.
- Internal logs only for tuning/debug.