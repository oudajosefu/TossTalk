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