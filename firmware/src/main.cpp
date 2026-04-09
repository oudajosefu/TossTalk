// TossTalk - throwable wireless microphone firmware
// Target: Seeed Studio XIAO ESP32 S3 Sense + GY-521 MPU-6050
//
// Architecture v2 - small-packet streaming
// -----------------------------------------
// Every audio notification is <= 20 bytes so it always fits in the default
// 23-byte ATT MTU.  No MTU negotiation is required for the audio stream
// to work.  A 20-ms frame (160 samples @ 8 kHz) is split into 5 BLE
// sub-packets:
//
//   Sub-packet 0  (20 bytes):
//     [0]     frame_seq   (uint8, wraps at 256)
//     [1]     0x00 | muted_flag (bit 7)
//     [2..3]  ADPCM predictor (int16 LE)
//     [4]     ADPCM step_index
//     [5..19] 15 ADPCM bytes = 30 samples
//
//   Sub-packets 1..3  (20 bytes each):
//     [0]     frame_seq
//     [1]     pkt_index (1..3) | muted_flag (bit 7)
//     [2..19] 18 ADPCM bytes = 36 samples
//
//   Sub-packet 4  (13 bytes):
//     [0]     frame_seq
//     [1]     0x04 | muted_flag (bit 7)
//     [2..12] 11 ADPCM bytes = 22 samples
//
//   Total: 30 + 36*3 + 22 = 160 samples per frame.

#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <driver/i2s.h>
#include <NimBLEDevice.h>
#include <Preferences.h>
#include <cmath>

// Forward-declare the NimBLE C function we need for setting a random address.
// The header (host/ble_hs_id.h) isn't on the NimBLE-Arduino 1.4.x include
// path, but the symbol is compiled into the library.
extern "C" int ble_hs_id_set_rnd(const uint8_t *rnd_addr);
extern "C" int ble_gap_update_params(uint16_t conn_handle,
                                      const struct ble_gap_upd_params *params);

// ── UUIDs ────────────────────────────────────────────────────────────────
static const char* DEVICE_NAME       = "TossTalk";
static const char* SERVICE_UUID      = "9f8d0001-6b7b-4f26-b10f-3aa861aa0001";
static const char* AUDIO_CHAR_UUID   = "9f8d0002-6b7b-4f26-b10f-3aa861aa0001";
static const char* BATT_CHAR_UUID    = "9f8d0003-6b7b-4f26-b10f-3aa861aa0001";
static const char* STATE_CHAR_UUID   = "9f8d0004-6b7b-4f26-b10f-3aa861aa0001";
static const char* CONTROL_CHAR_UUID = "9f8d0005-6b7b-4f26-b10f-3aa861aa0001";

// ── Gate states ──────────────────────────────────────────────────────────
enum class GateState : uint8_t {
  UnmutedLive        = 0,
  AirborneSuppressed = 1,
  ImpactLockout      = 2,
  Reacquire          = 3,
};

// ── IMU object ──────────────────────────────────────────────────────────
Adafruit_MPU6050 mpu;

// ── BLE objects ──────────────────────────────────────────────────────────
NimBLEServer*         bleServer   = nullptr;
NimBLECharacteristic* audioChar   = nullptr;
NimBLECharacteristic* batteryChar = nullptr;
NimBLECharacteristic* stateChar   = nullptr;
NimBLECharacteristic* controlChar = nullptr;

// ── Runtime state ────────────────────────────────────────────────────────
GateState gateState          = GateState::UnmutedLive;
uint32_t  lockoutStartMs     = 0;
uint32_t  reacquireStartMs   = 0;
uint32_t  airborneStartMs    = 0;
uint32_t  lastBatteryNotifyMs = 0;
uint32_t  lastAudioTickMs    = 0;
uint8_t   frameSeq           = 0;

bool     bleClientConnected = false;
uint32_t bleConnectedAtMs   = 0;
uint16_t bleConnHandle      = 0xFFFF;
bool     firstAudioSent     = false;
bool     connParamsUpdated  = false;
bool     micAvailable       = false;
volatile bool advRestartPending = false;
uint8_t advRestartTries = 0;
uint32_t advNextRetryMs = 0;
Preferences prefs;

// Persisted random-static BLE address for user-friendly reconnect behavior.
// A stable MAC across reboots means OS/browser can reconnect reliably
// without "new device" prompts each power cycle.
uint8_t   bleAddrRnd[6]     = {0};

// Diagnostic counters
uint32_t dbgNotifyOk    = 0;
uint32_t dbgNotifyFail  = 0;
uint32_t dbgMbufFail    = 0;   // subset of fails: mbuf pool exhausted
uint32_t dbgFramesSent  = 0;
uint32_t dbgFramesSkip  = 0;   // frames intentionally skipped for backoff
uint32_t lastDiagMs     = 0;
uint16_t consecFail     = 0;   // consecutive rawNotify failures

// How long after connect to avoid ALL non-BLE work so the NimBLE stack
// can handle service discovery unimpeded.
static constexpr uint32_t BLE_SETTLING_MS = 3500;

// ── Audio capture ────────────────────────────────────────────────────────
static constexpr uint16_t AUDIO_SAMPLE_RATE  = 8000;
static constexpr uint16_t AUDIO_SAMPLE_COUNT = 160;
static constexpr size_t   MIC_RING_SIZE      = 4;
// Tunable audio params — defaults here, adjustable at runtime via BLE
static int32_t micTargetGainQ12 = 20480; // 5.0× in Q12 (desired amplification)
static int16_t inputNoiseGate   = 225;   // frame-RMS gate threshold (raw-mic units, pre-gain)
static int16_t inputSoftLimit   = 18000; // peak output ceiling after gain
static constexpr i2s_port_t I2S_PORT     = I2S_NUM_0;
static constexpr int        I2S_CLK_PIN  = 42;  // XIAO S3 Sense PDM CLK
static constexpr int        I2S_DATA_PIN = 41;  // XIAO S3 Sense PDM DATA

int16_t micRing[MIC_RING_SIZE][AUDIO_SAMPLE_COUNT] = {};
size_t  micWriteIndex = 0;
size_t  micReadIndex  = 0;
size_t  micQueued     = 0;

// ── IMA ADPCM codec ─────────────────────────────────────────────────────
struct AdpcmState { int predictor = 0; int index = 0; };
AdpcmState adpcmState;

// ── Audio processing state (persists between frames) ─────────────────────
static int32_t prevLimiterScaleQ12 = 20480; // start at target gain (5.0× in Q12)
static int32_t dcEst = 0;                   // DC offset estimate (sample units)

static const int kIndexTable[16] = {
  -1, -1, -1, -1, 2, 4, 6, 8,
  -1, -1, -1, -1, 2, 4, 6, 8,
};
static const int kStepTable[89] = {
  7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,
  60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,
  337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,
  1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,
  5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,
  18500,20350,22385,24623,27086,29794,32767,
};

// ── Forward declarations ─────────────────────────────────────────────────
void notifyGateState();
void resetAudioTxState();

// ── Notification warmup guard ────────────────────────────────────────────
bool canNotify() {
  return bleClientConnected && (millis() - bleConnectedAtMs >= 1500);
}

// ── Raw NimBLE C-API notification ────────────────────────────────────────
bool rawNotify(NimBLECharacteristic* chr, const uint8_t* data, size_t len) {
  if (bleConnHandle == 0xFFFF) return false;
  struct os_mbuf* om = ble_hs_mbuf_from_flat(data, static_cast<uint16_t>(len));
  if (!om) {
    // mbuf pool exhausted — yield so NimBLE host task can process
    // TX completions and return mbufs to the pool.
    dbgNotifyFail++;
    dbgMbufFail++;
    delay(2);
    return false;
  }
  int rc = ble_gattc_notify_custom(bleConnHandle, chr->getHandle(), om);
  if (rc != 0) {
    dbgNotifyFail++;
    return false;
  }
  dbgNotifyOk++;
  return true;
}

// ── Gate helpers ─────────────────────────────────────────────────────────
const char* gateStateName(GateState s) {
  switch (s) {
    case GateState::UnmutedLive:        return "UnmutedLive";
    case GateState::AirborneSuppressed: return "Airborne";
    case GateState::ImpactLockout:      return "Impact";
    case GateState::Reacquire:          return "Reacquire";
  }
  return "?";
}

// ── BLE callbacks ────────────────────────────────────────────────────────
class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* pServer, ble_gap_conn_desc* desc) override {
    // Stop advertising while connected - frees radio time for GATT.
    NimBLEDevice::getAdvertising()->stop();
    bleClientConnected = true;
    bleConnectedAtMs   = millis();
    bleConnHandle      = desc->conn_handle;
    firstAudioSent     = false;
    resetAudioTxState();
    Serial.printf("[BLE] Connected handle=%u\n", bleConnHandle);
  }
  void onDisconnect(NimBLEServer* pServer) override {
    bleClientConnected = false;
    bleConnectedAtMs   = 0;
    bleConnHandle      = 0xFFFF;
    firstAudioSent     = false;
    connParamsUpdated  = false;
    resetAudioTxState();
    advRestartPending  = true;
    advRestartTries    = 0;
    advNextRetryMs     = millis();
    Serial.println("[BLE] Disconnected");
  }
};

class ControlCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* pCharacteristic) override {
    std::string val = pCharacteristic->getValue();
    // Binary commands: first byte < 0x20 distinguishes from text "ping"
    if (val.size() >= 1 && static_cast<uint8_t>(val[0]) < 0x20) {
      const uint8_t* d = reinterpret_cast<const uint8_t*>(val.data());
      if (d[0] == 0x01 && val.size() >= 9) {
        // CMD_SET_AUDIO_PARAMS: [0x01][gain_q12:i32le][noise_gate:i16le][soft_limit:i16le]
        int32_t g = static_cast<int32_t>(d[1] | (d[2]<<8) | (d[3]<<16) | (d[4]<<24));
        int16_t ng = static_cast<int16_t>(d[5] | (d[6]<<8));
        int16_t sl = static_cast<int16_t>(d[7] | (d[8]<<8));
        // Validate ranges
        if (g < 0) g = 0;
        if (g > 81920) g = 81920;       // max 20.0×
        if (ng < 0) ng = 0;
        if (ng > 2000) ng = 2000;
        if (sl < 1000) sl = 1000;
        if (sl > 32767) sl = 32767;
        micTargetGainQ12 = g;
        inputNoiseGate = ng;
        inputSoftLimit = sl;
        prevLimiterScaleQ12 = g;  // reset limiter to new target
        Serial.printf("[CTRL] Audio params: gain=%.1fx gate=%d limit=%d\n",
                      static_cast<float>(g) / 4096.0f, ng, sl);
      }
      return;
    }
    // Text commands
    if (val == "ping") {
      gateState = GateState::Reacquire;
      reacquireStartMs = millis();
      notifyGateState();
    }
  }
};

// ── IMU / gate logic ─────────────────────────────────────────────────────
float readAccelMagnitudeG() {
  sensors_event_t a, g, temp;
  mpu.getEvent(&a, &g, &temp);
  constexpr float G = 9.80665f;
  return std::sqrt(a.acceleration.x * a.acceleration.x +
                   a.acceleration.y * a.acceleration.y +
                   a.acceleration.z * a.acceleration.z) / G;
}

void notifyGateState() {
  uint8_t p[2] = {static_cast<uint8_t>(gateState), 0};
  stateChar->setValue(p, sizeof(p));
  if (canNotify()) rawNotify(stateChar, p, sizeof(p));
}

void updateGateState() {
  const uint32_t now = millis();
  const float mag = readAccelMagnitudeG();
  constexpr float AIRBORNE_G      = 0.35f;
  constexpr float IMPACT_G        = 2.20f;
  constexpr float STATIONARY_LO_G = 0.7f;   // near 1g = at rest in someone's hand
  constexpr float STATIONARY_HI_G = 1.4f;
  constexpr uint32_t LOCKOUT_MS   = 120;
  constexpr uint32_t REACQ_MS     = 150;
  constexpr uint32_t AIRBORNE_TIMEOUT_MS = 500;  // max time in airborne before auto-recover
  GateState prev = gateState;
  switch (gateState) {
    case GateState::UnmutedLive:
      if (mag < AIRBORNE_G) { gateState = GateState::AirborneSuppressed; airborneStartMs = now; } break;
    case GateState::AirborneSuppressed:
      if (mag > IMPACT_G) {
        gateState = GateState::ImpactLockout; lockoutStartMs = now;
      } else if (now - airborneStartMs >= AIRBORNE_TIMEOUT_MS &&
                 mag >= STATIONARY_LO_G && mag <= STATIONARY_HI_G) {
        // Gentle catch or placed down — no impact detected but device is
        // clearly stationary (near 1g).  Skip lockout, go straight to live.
        gateState = GateState::UnmutedLive;
      }
      break;
    case GateState::ImpactLockout:
      if (now - lockoutStartMs >= LOCKOUT_MS) { gateState = GateState::Reacquire; reacquireStartMs = now; } break;
    case GateState::Reacquire:
      if (now - reacquireStartMs >= REACQ_MS) gateState = GateState::UnmutedLive; break;
  }
  if (prev != gateState) {
    Serial.printf("[GATE] %s -> %s (mag=%.2fg)\n",
                  gateStateName(prev), gateStateName(gateState), mag);
    notifyGateState();
  }
}

// ── Battery (stub - no fuel gauge on XIAO S3) ───────────────────────────
void updateBattery() {
  const uint32_t now = millis();
  if (now - lastBatteryNotifyMs < 10000) return;
  lastBatteryNotifyMs = now;
  uint8_t pl[2] = {100, 0};  // 100%, not charging
  batteryChar->setValue(pl, sizeof(pl));
  if (canNotify()) rawNotify(batteryChar, pl, sizeof(pl));
}

// ── IMA ADPCM encoder ───────────────────────────────────────────────────
uint8_t encodeNibble(int16_t sample, AdpcmState& st) {
  int step = kStepTable[st.index];
  int diff = static_cast<int>(sample) - st.predictor;
  uint8_t code = 0;
  if (diff < 0) { code = 8; diff = -diff; }
  int delta = step >> 3;
  if (diff >= step)        { code |= 4; diff -= step;        delta += step; }
  if (diff >= (step >> 1)) { code |= 2; diff -= (step >> 1); delta += (step >> 1); }
  if (diff >= (step >> 2)) { code |= 1;                      delta += (step >> 2); }
  st.predictor += (code & 8) ? -delta : delta;
  if (st.predictor >  32767) st.predictor =  32767;
  if (st.predictor < -32768) st.predictor = -32768;
  st.index += kIndexTable[code & 0x0F];
  if (st.index < 0)  st.index = 0;
  if (st.index > 88) st.index = 88;
  return code & 0x0F;
}

// ── Mic ring buffer ──────────────────────────────────────────────────────
void queueMicCapture() {
  if (!micAvailable) return;
  size_t bytesRead = 0;
  esp_err_t err = i2s_read(I2S_PORT, micRing[micWriteIndex],
                           AUDIO_SAMPLE_COUNT * sizeof(int16_t),
                           &bytesRead, 0);  // non-blocking
  if (err == ESP_OK && bytesRead == AUDIO_SAMPLE_COUNT * sizeof(int16_t)) {
    // Raw samples — no magnification here; gain is applied together with
    // the soft limiter in encodeNewFrame() to prevent clipping distortion.
    micWriteIndex = (micWriteIndex + 1) % MIC_RING_SIZE;
    if (micQueued < MIC_RING_SIZE) ++micQueued;
    else micReadIndex = (micReadIndex + 1) % MIC_RING_SIZE;
  }
}

bool popMicFrame(int16_t* out) {
  if (!micAvailable || micQueued <= 1) { memset(out, 0, AUDIO_SAMPLE_COUNT * 2); return false; }
  memcpy(out, micRing[micReadIndex], AUDIO_SAMPLE_COUNT * 2);
  micReadIndex = (micReadIndex + 1) % MIC_RING_SIZE;
  --micQueued;
  return true;
}

// ── Paced audio frame sender ─────────────────────────────────────────────
// We encode a full 20-ms frame (160 samples → 80 ADPCM bytes) once, then
// drip-feed one sub-packet per loop() call with >= 4 ms spacing.  This
// keeps the NimBLE outbound mbuf pool from overflowing.

static constexpr uint8_t PKT0_ADPCM = 15;  // 30 samples
static constexpr uint8_t PKTN_ADPCM = 18;  // 36 samples
static constexpr uint8_t PKT4_ADPCM = 11;  // 22 samples
static constexpr uint8_t TOTAL_SUB  = 5;
static constexpr uint32_t SUB_INTERVAL_MS = 4;  // ms between sub-packets

// Frame encoding buffer (persists between loop calls)
uint8_t  txAdpcm[80];
int16_t  txPred      = 0;
uint8_t  txIdx       = 0;
uint8_t  txMutedBit  = 0;
uint8_t  txFrameSeq  = 0;
uint8_t  txSubNext   = TOTAL_SUB;  // TOTAL_SUB = idle (no frame pending)
uint32_t txLastSubMs = 0;

void resetAudioTxState() {
  consecFail = 0;
  txSubNext = TOTAL_SUB;
  txLastSubMs = 0;
  lastAudioTickMs = 0;
}

void encodeNewFrame() {
  queueMicCapture();

  const bool talkOpen = (gateState == GateState::UnmutedLive ||
                         gateState == GateState::Reacquire);
  txMutedBit = talkOpen ? 0x00 : 0x80;

  int16_t samples[AUDIO_SAMPLE_COUNT];
  const bool haveMic = popMicFrame(samples);
  if (!(talkOpen && haveMic)) memset(samples, 0, sizeof(samples));
  else {
    // ── DC offset removal (simple IIR, ~5 Hz cutoff at 8 kHz) ─────────
    // dcEst tracks the running DC bias in sample units.
    // y[n] = x[n] - dcEst;  dcEst += (x[n] - dcEst) >> 8
    // Alpha = 1 - 1/256 = 0.996 → cutoff ≈ 5 Hz.  Overflow-safe.
    for (size_t i = 0; i < AUDIO_SAMPLE_COUNT; ++i) {
      int32_t raw = static_cast<int32_t>(samples[i]);
      dcEst += (raw - dcEst) >> 8;
      int32_t s = raw - dcEst;
      if (s > 32767) s = 32767;
      if (s < -32768) s = -32768;
      samples[i] = static_cast<int16_t>(s);
    }

    // ── Frame-level noise gate (on raw-level samples, before gain) ───
    // Compute frame RMS, then apply gain envelope to the whole frame.
    // This avoids per-sample gating which creates high-freq impulse artifacts.
    const int32_t GATE_CLOSE = inputNoiseGate / 2;
    const int32_t GATE_OPEN  = inputNoiseGate;
    int64_t sumSq = 0;
    for (size_t i = 0; i < AUDIO_SAMPLE_COUNT; ++i) {
      int32_t s = static_cast<int32_t>(samples[i]);
      sumSq += s * s;
    }
    int32_t frameRms = 0;
    {
      // Integer sqrt of (sumSq / AUDIO_SAMPLE_COUNT)
      int64_t meanSq = sumSq / AUDIO_SAMPLE_COUNT;
      int32_t r = 0;
      if (meanSq > 0) { r = 1; while (static_cast<int64_t>(r) * r < meanSq) ++r; if (static_cast<int64_t>(r) * r > meanSq) --r; }
      frameRms = r;
    }
    if (frameRms < GATE_CLOSE) {
      // Fully closed — zero the whole frame
      memset(samples, 0, sizeof(int16_t) * AUDIO_SAMPLE_COUNT);
    } else if (frameRms < GATE_OPEN) {
      // Transition zone — scale entire frame with squared fade
      int32_t range = GATE_OPEN - GATE_CLOSE;
      int32_t above = frameRms - GATE_CLOSE;
      // scaleQ12 ramps from 0 at GATE_CLOSE to 4096 at GATE_OPEN (quadratic)
      int32_t scaleQ12 = (4096 * above * above) / (range * range);
      for (size_t i = 0; i < AUDIO_SAMPLE_COUNT; ++i) {
        int32_t s = (static_cast<int32_t>(samples[i]) * scaleQ12) >> 12;
        samples[i] = static_cast<int16_t>(s);
      }
    }
    // else: frameRms >= GATE_OPEN — pass through unmodified

    // ── Unified gain + soft limiter (no clipping possible) ────────────
    // Compute raw peak, then cap the gain so output never exceeds the
    // soft limit.  This completely eliminates hard clipping distortion.
    int32_t rawPeak = 0;
    for (size_t i = 0; i < AUDIO_SAMPLE_COUNT; ++i) {
      int32_t a = std::abs(static_cast<int32_t>(samples[i]));
      if (a > rawPeak) rawPeak = a;
    }

    // Desired gain = micTargetGainQ12 (default 5.0× = 20480 in Q12)
    // If that would push the peak above inputSoftLimit, reduce gain.
    int32_t targetGainQ12 = micTargetGainQ12;
    if (rawPeak > 0) {
      int32_t maxGainQ12 = (static_cast<int32_t>(inputSoftLimit) << 12) / rawPeak;
      if (targetGainQ12 > maxGainQ12) targetGainQ12 = maxGainQ12;
    }

    // Smooth gain transitions: instant attack, slow release (~8 frames)
    int32_t curScale = prevLimiterScaleQ12;
    if (targetGainQ12 < curScale) {
      curScale = targetGainQ12;  // attack: immediate
    } else {
      curScale = curScale + ((targetGainQ12 - curScale) >> 3);  // release: 1/8 per frame
    }

    // Apply gain with linear interpolation across the frame
    const int32_t startScale = prevLimiterScaleQ12;
    for (size_t i = 0; i < AUDIO_SAMPLE_COUNT; ++i) {
      int32_t interpScale = startScale +
          ((curScale - startScale) * static_cast<int32_t>(i)) /
          static_cast<int32_t>(AUDIO_SAMPLE_COUNT);
      int32_t s = (static_cast<int32_t>(samples[i]) * interpScale) >> 12;
      if (s > 32767) s = 32767;
      if (s < -32768) s = -32768;
      samples[i] = static_cast<int16_t>(s);
    }
    prevLimiterScaleQ12 = curScale;
  }

  AdpcmState enc = adpcmState;
  txPred = static_cast<int16_t>(enc.predictor);
  txIdx  = static_cast<uint8_t>(enc.index);

  for (size_t i = 0; i < AUDIO_SAMPLE_COUNT; i += 2) {
    uint8_t n0 = encodeNibble(samples[i],   enc);
    uint8_t n1 = encodeNibble(samples[i+1], enc);
    txAdpcm[i/2] = static_cast<uint8_t>((n1 << 4) | n0);
  }
  adpcmState = enc;

  txFrameSeq = frameSeq;
  txSubNext  = 0;
  txLastSubMs = millis();
}

bool sendNextSubPacket() {
  if (txSubNext >= TOTAL_SUB) return false;  // idle

  uint8_t pkt[20];
  size_t  len = 0;

  switch (txSubNext) {
    case 0:
      pkt[0] = txFrameSeq;
      pkt[1] = 0x00 | txMutedBit;
      pkt[2] = static_cast<uint8_t>(txPred & 0xFF);
      pkt[3] = static_cast<uint8_t>((txPred >> 8) & 0xFF);
      pkt[4] = txIdx;
      memcpy(&pkt[5], &txAdpcm[0], PKT0_ADPCM);
      len = 20;
      break;
    case 1: case 2: case 3: {
      size_t adpcmOff = PKT0_ADPCM + (txSubNext - 1) * PKTN_ADPCM;
      pkt[0] = txFrameSeq;
      pkt[1] = txSubNext | txMutedBit;
      memcpy(&pkt[2], &txAdpcm[adpcmOff], PKTN_ADPCM);
      len = 20;
      break;
    }
    case 4: {
      size_t adpcmOff = PKT0_ADPCM + 3 * PKTN_ADPCM;  // 69
      pkt[0] = txFrameSeq;
      pkt[1] = 0x04 | txMutedBit;
      memcpy(&pkt[2], &txAdpcm[adpcmOff], PKT4_ADPCM);
      len = 13;
      break;
    }
    default:
      return false;
  }

  bool ok = rawNotify(audioChar, pkt, len);
  if (!ok) {
    // BLE buffer full - DON'T advance txSubNext, retry on next loop
    txLastSubMs = millis();  // still pace the retry
    return false;
  }

  txSubNext++;
  txLastSubMs = millis();

  if (txSubNext >= TOTAL_SUB) {
    // Frame complete
    dbgFramesSent++;
    if (!firstAudioSent) {
      firstAudioSent = true;
      Serial.printf("[BLE] First audio seq=%u MTU=%u\n",
                    txFrameSeq, ble_att_mtu(bleConnHandle));

    }
    ++frameSeq;
  }
  return true;
}

void sendMicAudioFrame() {
  if (!canNotify()) return;
  const uint32_t now = millis();
  const uint16_t mtu = ble_att_mtu(bleConnHandle);

  // ── Single-packet mode (MTU >= 88) ──────────────────────────────────
  // Send the entire 80-byte ADPCM frame + 5-byte header in one notification.
  // This is 5× fewer mbufs and vastly more reliable than sub-packets.
  if (mtu >= 88) {
    // signed comparison: if lastAudioTickMs is in the future (from skip),
    // (now - future) wraps negative, which is < 20 → correctly blocks.
    if (static_cast<int32_t>(now - lastAudioTickMs) < 20) return;
    lastAudioTickMs = now;

    encodeNewFrame();

    uint8_t pkt[85];
    pkt[0] = txFrameSeq;
    pkt[1] = 0x00 | txMutedBit;
    pkt[2] = static_cast<uint8_t>(txPred & 0xFF);
    pkt[3] = static_cast<uint8_t>((txPred >> 8) & 0xFF);
    pkt[4] = txIdx;
    memcpy(&pkt[5], txAdpcm, 80);

    if (rawNotify(audioChar, pkt, 85)) {
      consecFail = 0;
      dbgFramesSent++;
      if (!firstAudioSent) {
        firstAudioSent = true;
        Serial.printf("[BLE] Single-pkt mode seq=%u MTU=%u\n", txFrameSeq, mtu);

      }
    } else {
      ++consecFail;
      // Frame is lost (ADPCM state already advanced) — accept the gap.
      // Skip future frames so the BLE stack can drain its TX queue.
      if (consecFail >= 3) {
        lastAudioTickMs += 20;     // skip 1 extra frame (40 ms gap)
        dbgFramesSkip++;
      }
      if (consecFail >= 8) {
        lastAudioTickMs += 60;     // skip 3 more frames (total 100 ms gap)
        dbgFramesSkip += 3;
      }
    }
    ++frameSeq;                    // ALWAYS advance — stale retries break ADPCM sync
    txSubNext = TOTAL_SUB;
    return;
  }

  // ── Sub-packet mode (MTU < 88) ─────────────────────────────────────
  if (txSubNext < TOTAL_SUB) {
    if (now - txLastSubMs >= SUB_INTERVAL_MS) {
      sendNextSubPacket();
    }
    return;
  }

  if (now - lastAudioTickMs < 20) return;
  lastAudioTickMs = now;

  encodeNewFrame();
  sendNextSubPacket();
}

// ── BLE setup ────────────────────────────────────────────────────────────
void setupBle() {
  NimBLEDevice::init(DEVICE_NAME);
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);

  // ── Use a persisted random-static address (stable across reboots) ───────
  // This keeps reconnect/repair behavior consistent for non-technical users
  // while still avoiding public MAC tracking.
  {
    bool haveSaved = false;
    if (prefs.begin("tosstalk", true)) {
      size_t got = prefs.getBytes("ble_addr", bleAddrRnd, sizeof(bleAddrRnd));
      haveSaved = (got == sizeof(bleAddrRnd));
      prefs.end();
    }

    if (!haveSaved) {
      uint32_t r0 = esp_random(), r1 = esp_random();
      memcpy(bleAddrRnd, &r0, 4);
      memcpy(bleAddrRnd + 4, &r1, 2);
      bleAddrRnd[5] = (bleAddrRnd[5] & 0x3F) | 0xC0;  // random static type
      if ((bleAddrRnd[0] | bleAddrRnd[1] | bleAddrRnd[2] |
           bleAddrRnd[3] | bleAddrRnd[4] | (bleAddrRnd[5] & 0x3F)) == 0) {
        bleAddrRnd[0] = 0x01;
      }
      if (prefs.begin("tosstalk", false)) {
        prefs.putBytes("ble_addr", bleAddrRnd, sizeof(bleAddrRnd));
        prefs.end();
      }
    }

    ble_hs_id_set_rnd(bleAddrRnd);
    NimBLEDevice::setOwnAddrType(BLE_OWN_ADDR_RANDOM);
    Serial.printf("[BLE] Persisted random MAC: %02X:%02X:%02X:%02X:%02X:%02X\n",
                  bleAddrRnd[5], bleAddrRnd[4], bleAddrRnd[3],
                  bleAddrRnd[2], bleAddrRnd[1], bleAddrRnd[0]);
  }

  // Delete all stored bonds so the ESP32 side is clean too.
  NimBLEDevice::deleteAllBonds();

  // Disable bonding and security entirely - we don't need encryption for
  // classroom audio, and bonding causes Windows to cache our GATT database
  // which breaks when the firmware changes.
  NimBLEDevice::setSecurityAuth(false, false, false);
  NimBLEDevice::setSecurityIOCap(BLE_HS_IO_NO_INPUT_OUTPUT);

  bleServer = NimBLEDevice::createServer();
  bleServer->setCallbacks(new ServerCallbacks());
  auto* svc = bleServer->createService(SERVICE_UUID);

  // max_len=20 keeps the GATT attribute table compact for service discovery.
  // rawNotify() bypasses max_len and can send up to MTU-3 bytes directly.
  audioChar   = svc->createCharacteristic(AUDIO_CHAR_UUID,   NIMBLE_PROPERTY::NOTIFY, 20);
  batteryChar = svc->createCharacteristic(BATT_CHAR_UUID,    NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  stateChar   = svc->createCharacteristic(STATE_CHAR_UUID,   NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  controlChar = svc->createCharacteristic(CONTROL_CHAR_UUID, NIMBLE_PROPERTY::WRITE);
  controlChar->setCallbacks(new ControlCallbacks());

  svc->start();
  auto* adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(SERVICE_UUID);
  adv->setScanResponse(true);
  adv->setMinInterval(160);  // 100 ms
  adv->setMaxInterval(320);  // 200 ms
  adv->start();
}

// ── PDM microphone setup (XIAO ESP32 S3 Sense) ─────────────────────────
void setupMic() {
  i2s_config_t i2s_cfg = {};
  i2s_cfg.mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX | I2S_MODE_PDM);
  i2s_cfg.sample_rate = AUDIO_SAMPLE_RATE;
  i2s_cfg.bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT;
  i2s_cfg.channel_format = I2S_CHANNEL_FMT_ONLY_LEFT;
  i2s_cfg.communication_format = I2S_COMM_FORMAT_STAND_I2S;
  i2s_cfg.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1;
  i2s_cfg.dma_buf_count = 8;
  i2s_cfg.dma_buf_len = AUDIO_SAMPLE_COUNT;
  i2s_cfg.use_apll = false;

  i2s_pin_config_t pin_cfg = {};
  pin_cfg.bck_io_num = I2S_PIN_NO_CHANGE;
  pin_cfg.ws_io_num = I2S_CLK_PIN;
  pin_cfg.data_out_num = I2S_PIN_NO_CHANGE;
  pin_cfg.data_in_num = I2S_DATA_PIN;

  micAvailable = (i2s_driver_install(I2S_PORT, &i2s_cfg, 0, NULL) == ESP_OK &&
                  i2s_set_pin(I2S_PORT, &pin_cfg) == ESP_OK);
  Serial.printf("[MIC] I2S PDM available=%d rate=%d gain=%.1fx gate=%d limit=%d\n",
                micAvailable, AUDIO_SAMPLE_RATE,
                static_cast<float>(micTargetGainQ12) / 4096.0f,
                inputNoiseGate, inputSoftLimit);
}

// ── Arduino entry points ─────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  while (!Serial && millis() < 3000) { delay(10); }  // wait for USB-CDC host to connect (up to 3s)

  // I2C for MPU-6050: D4=GPIO5 (SDA), D5=GPIO6 (SCL)
  Wire.begin(D4, D5);
  if (!mpu.begin(0x68, &Wire)) {
    Serial.println("[IMU] MPU-6050 not found!");
  } else {
    mpu.setAccelerometerRange(MPU6050_RANGE_4_G);
    mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
    Serial.println("[IMU] MPU-6050 ready");
  }

  setupMic();
  setupBle();
  notifyGateState();
  queueMicCapture();
}

void loop() {
  const uint32_t now = millis();

  // During the settling window after BLE connect, yield CPU so the
  // NimBLE host task can handle service discovery unimpeded.
  const bool settling = bleClientConnected &&
                        (now - bleConnectedAtMs < BLE_SETTLING_MS);
  if (settling) {
    delay(10);
    return;
  }

  // Request shorter connection interval once after settling.
  // Chrome/Edge default to ~30ms; 15ms doubles our TX throughput.
  if (bleClientConnected && !connParamsUpdated) {
    connParamsUpdated = true;
    struct ble_gap_upd_params params = {};
    params.itvl_min = 8;              // 10.0 ms  (units of 1.25 ms)
    params.itvl_max = 24;             // 30.0 ms
    params.latency  = 0;
    params.supervision_timeout = 400; // 4 s
    int rc = ble_gap_update_params(bleConnHandle, &params);
    Serial.printf("[BLE] Conn param update request: rc=%d\n", rc);
  }

  const bool streaming = bleClientConnected && firstAudioSent;

  // Never block inside BLE callbacks; retry advertising from loop.
  if (!bleClientConnected && advRestartPending && now >= advNextRetryMs) {
    auto* adv = NimBLEDevice::getAdvertising();
    bool ok = false;
    if (adv) {
      adv->stop();
      ok = adv->start();
    }
    if (ok) {
      advRestartPending = false;
      Serial.println("[BLE] Advertising restarted");
    } else {
      advRestartTries++;
      if (advRestartTries >= 20) {
        advRestartPending = false;
        Serial.println("[BLE] Advertising restart failed (gave up)");
      } else {
        advNextRetryMs = now + 100;
      }
    }
  }

  // IMU must be polled every loop iteration — a throw is only ~300ms
  // and the freefall window can be <100ms.
  updateGateState();
  updateBattery();
  sendMicAudioFrame();

  // Periodic diagnostics (every 5s)
  if (streaming && (now - lastDiagMs >= 5000)) {
    lastDiagMs = now;
    Serial.printf("[DIAG] sent=%u ok=%u fail=%u mbuf=%u skip=%u cf=%u\n",
                  dbgFramesSent, dbgNotifyOk, dbgNotifyFail,
                  dbgMbufFail, dbgFramesSkip, consecFail);
  }

  delay(1);
}
