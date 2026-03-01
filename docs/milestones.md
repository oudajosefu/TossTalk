# Milestones

## M0 - Foundations

- Repo scaffold, protocol draft, architecture docs
- Acceptance: docs exist and align with no-PTT + auto-recover model

## M1 - Device runtime baseline

- IMU gate state machine running on device
- Battery HUD visible at all times
- BLE service and characteristics available
- Acceptance:
  - Battery shows continuously during runtime
  - Gate state transitions and notifications are emitted

## M2 - Web integration baseline

- Chromium PWA connects over Web Bluetooth
- Battery and state rendered in web UI
- Acceptance:
  - Connect/disconnect works repeatedly
  - State + battery updates visible in UI

## M3 - Near-live audio MVP

- Continuous audio notify pipeline active
- Browser playback of BLE frames
- Acceptance:
  - Intelligible speech in real-world test loop
  - Fast recovery to talk path after toss events

## M4 - Reliability hardening

- Threshold tuning, reconnect resilience, logging
- Acceptance:
  - Agreed talk-availability target reached
  - No user intervention required during test sessions