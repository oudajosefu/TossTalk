# TossTalk

Throwable classroom microphone prototype for M5StickC Plus2.

## Current implementation status (M0/M1 bootstrap)

- ✅ Repository scaffold for firmware + web app + CI
- ✅ Always-on interaction model (no push-to-talk)
- ✅ Battery HUD requirement captured and started in firmware loop
- ✅ BLE protocol UUIDs defined and wired in firmware/web stubs
- ✅ PWA shell for desktop Chromium with Web Bluetooth connect flow
- ✅ Auto-reconnect and stream stats in web console
- ✅ Web Serial flashing page stub (Chromium-only path)
- ✅ Initial microphone capture over BLE frames (8 kHz PCM)
- 🚧 Near-live BLE audio quality tuning and robust IMU thresholds

## Product constraints

- No teacher interaction required after power + pairing
- Auto-recover behavior (no teacher warning workflow)
- Desktop Chromium target (Windows/ChromeOS/macOS)
- Battery percentage visible on device screen at all times

## Repo layout

- [firmware](firmware): PlatformIO firmware for M5StickC Plus2
- [web](web): Static PWA (GitHub Pages deploy target)
- [docs](docs): Architecture, protocol, milestones, and test plan
- [.github/workflows](.github/workflows): CI/CD pipelines

## Quick start

### Firmware

1. Open [firmware/platformio.ini](firmware/platformio.ini)
2. Build/upload with PlatformIO (local dev)

### Web app (local)

Serve [web](web) with any static server and open in Chromium.

### Deploy

Push to `main`; GitHub Actions deploys [web](web) to Pages.