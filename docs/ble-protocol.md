# BLE Protocol (Draft v1)

Service UUID:

- `9f8d0001-6b7b-4f26-b10f-3aa861aa0001`

Characteristics:

- Audio Notify: `9f8d0002-6b7b-4f26-b10f-3aa861aa0001`
- Battery Read/Notify: `9f8d0003-6b7b-4f26-b10f-3aa861aa0001`
- State Notify: `9f8d0004-6b7b-4f26-b10f-3aa861aa0001`
- Control Write: `9f8d0005-6b7b-4f26-b10f-3aa861aa0001`

## Audio frame (notify payload)

`[seq:u16][sampleRate:u16][sampleCount:u8][flags:u8][codec:u8][reserved:u8][payload...]`

- `flags bit0`: muted by motion
- `flags bit1`: mic unavailable
- `sampleRate`: initial target 8000
- `sampleCount`: 160 for 20 ms @ 8 kHz

`codec` enum:

- `0` = PCM16LE
- `1` = IMA ADPCM

For `codec=1`, payload format is:

`[predictor:i16le][index:u8][reserved:u8][adpcm-nibbles...]`

- ADPCM nibble packing: low nibble first, then high nibble
- For 160 samples, ADPCM data is 80 bytes

## Battery payload

`[percent:u8][charging:u8]`

## State payload

`[gateState:u8][reserved:u8]`

`gateState` enum:

- `0` = `UnmutedLive`
- `1` = `AirborneSuppressed`
- `2` = `ImpactLockout`
- `3` = `Reacquire`

## Control payload (write)

Variable-length. The first byte determines the command type.

### Text commands

- `"ping"` — forces gate state to `Reacquire` (150 ms recovery)

### Binary commands (first byte < 0x20)

**`0x01` — Set Audio Parameters** (9 bytes)

| Offset | Type   | Field      | Range      | Default | Description                        |
| ------ | ------ | ---------- | ---------- | ------- | ---------------------------------- |
| 0      | u8     | cmd        | `0x01`     |         | Command ID                         |
| 1..4   | i32 LE | gain_q12   | 0–81920    | 20480   | Target gain in Q12 (÷4096 = ×mult) |
| 5..6   | i16 LE | noise_gate | 0–2000     | 216     | Frame-RMS gate threshold           |
| 7..8   | i16 LE | soft_limit | 1000–32767 | 18000   | Peak output ceiling after gain     |

Values are clamped to their valid ranges by the firmware. Changes take effect immediately but do not persist across reboots.

**`0x02` — Sleep (Power Off)** (1 byte)

| Offset | Type | Field | Value  | Description |
| ------ | ---- | ----- | ------ | ----------- |
| 0      | u8   | cmd   | `0x02` | Command ID  |

The device acknowledges via BLE (100 ms grace period), then enters ESP32-S3 deep sleep (~14 μA). All peripherals (BLE, I2S, I2C) are shut down and RAM is lost — waking is equivalent to a full reboot.

**Wake sources:**

- **BOOT button** (GPIO0, ext0 LOW) — press to wake immediately.

**Inactivity auto-sleep:** If no BLE client is connected for 10 continuous minutes the device enters deep sleep automatically (no command required).
