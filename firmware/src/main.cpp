// TossTalk – throwable classroom microphone firmware
// Target: M5StickC Plus2 (ESP32-PICO-V3-02)
//
// Architecture v2 – small-packet streaming
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

#include <M5Unified.h>
#include <NimBLEDevice.h>
#include <cmath>

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
uint32_t  lastBatteryTickMs  = 0;
uint32_t  lastBatteryNotifyMs = 0;
uint32_t  lastAudioTickMs    = 0;
uint8_t   frameSeq           = 0;

bool     bleClientConnected = false;
uint32_t bleConnectedAtMs   = 0;
uint16_t bleConnHandle      = 0xFFFF;
bool     firstAudioSent     = false;
bool     micAvailable       = false;
volatile bool displayDirty  = false;  // set in BLE callbacks, drawn in loop()

// How long after connect to avoid heavy work (SPI/I2C) so the BLE stack
// can handle service discovery + characteristic resolution unimpeded.
static constexpr uint32_t BLE_SETTLING_MS = 3500;

// ── Audio capture ────────────────────────────────────────────────────────
static constexpr uint16_t AUDIO_SAMPLE_RATE  = 8000;
static constexpr uint16_t AUDIO_SAMPLE_COUNT = 160;
static constexpr size_t   MIC_RING_SIZE      = 4;
int16_t micRing[MIC_RING_SIZE][AUDIO_SAMPLE_COUNT] = {};
size_t  micWriteIndex = 0;
size_t  micReadIndex  = 0;
size_t  micQueued     = 0;

// ── IMA ADPCM codec ─────────────────────────────────────────────────────
struct AdpcmState { int predictor = 0; int index = 0; };
AdpcmState adpcmState;

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

uint8_t lastBatteryPercent = 0;
bool    lastCharging       = false;

// ── Forward declarations ─────────────────────────────────────────────────
void notifyGateState();
void drawRuntimeStatus();

// ── Notification warmup guard ────────────────────────────────────────────
bool canNotify() {
  return bleClientConnected && (millis() - bleConnectedAtMs >= 2500);
}

// ── Raw NimBLE C-API notification ────────────────────────────────────────
bool rawNotify(NimBLECharacteristic* chr, const uint8_t* data, size_t len) {
  if (bleConnHandle == 0xFFFF) return false;
  struct os_mbuf* om = ble_hs_mbuf_from_flat(data, static_cast<uint16_t>(len));
  if (!om) return false;
  return ble_gattc_notify_custom(bleConnHandle, chr->getHandle(), om) == 0;
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

// ── Display ──────────────────────────────────────────────────────────────
void drawRuntimeStatus() {
  M5.Display.fillRect(0, 50, M5.Display.width(), 66, TFT_BLACK);
  M5.Display.setTextColor(TFT_CYAN, TFT_BLACK);
  M5.Display.setCursor(4, 54);
  M5.Display.printf("%s", gateStateName(gateState));
  M5.Display.setCursor(4, 74);
  uint16_t mtu = (bleConnHandle != 0xFFFF) ? ble_att_mtu(bleConnHandle) : 0;
  M5.Display.printf("BLE %s MTU%u", bleClientConnected ? "on" : "--", mtu);
  M5.Display.setCursor(4, 94);
  M5.Display.printf("MIC %s seq%u", micAvailable ? "ok" : "--", frameSeq);
}

void drawBatteryHud(uint8_t percent, bool charging) {
  uint16_t color = percent <= 10 ? TFT_RED : percent <= 20 ? TFT_YELLOW : TFT_WHITE;
  M5.Display.setTextColor(color, TFT_BLACK);
  M5.Display.fillRect(0, 0, M5.Display.width(), 18, TFT_BLACK);
  M5.Display.setCursor(4, 4);
  M5.Display.printf("BAT %3u%% %s", percent, charging ? "CHG" : "   ");
}

// ── BLE callbacks ────────────────────────────────────────────────────────
class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* pServer, ble_gap_conn_desc* desc) override {
    (void)pServer;
    bleClientConnected = true;
    bleConnectedAtMs   = millis();
    bleConnHandle      = desc->conn_handle;
    firstAudioSent     = false;
    displayDirty       = true;  // never do SPI here – it blocks the BLE host task
    Serial.printf("[BLE] Connected handle=%u\n", bleConnHandle);
  }
  void onDisconnect(NimBLEServer* pServer) override {
    bleClientConnected = false;
    bleConnectedAtMs   = 0;
    bleConnHandle      = 0xFFFF;
    firstAudioSent     = false;
    displayDirty       = true;
    Serial.println("[BLE] Disconnected");
    pServer->startAdvertising();
  }
};

class ControlCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* pCharacteristic) override {
    if (pCharacteristic->getValue() == "ping") {
      gateState = GateState::Reacquire;
      reacquireStartMs = millis();
      notifyGateState();
      drawRuntimeStatus();
    }
  }
};

// ── IMU / gate logic ─────────────────────────────────────────────────────
float readAccelMagnitudeG() {
  if (M5.Imu.update()) {
    auto d = M5.Imu.getImuData();
    return std::sqrt(d.accel.x*d.accel.x + d.accel.y*d.accel.y + d.accel.z*d.accel.z);
  }
  return 1.0f;
}

void notifyGateState() {
  uint8_t p[2] = {static_cast<uint8_t>(gateState), 0};
  stateChar->setValue(p, sizeof(p));
  if (canNotify()) rawNotify(stateChar, p, sizeof(p));
}

void updateGateState() {
  const uint32_t now = millis();
  const float mag = readAccelMagnitudeG();
  constexpr float AIRBORNE_G    = 0.35f;
  constexpr float IMPACT_G      = 2.20f;
  constexpr uint32_t LOCKOUT_MS = 120;
  constexpr uint32_t REACQ_MS   = 150;
  GateState prev = gateState;
  switch (gateState) {
    case GateState::UnmutedLive:
      if (mag < AIRBORNE_G) gateState = GateState::AirborneSuppressed; break;
    case GateState::AirborneSuppressed:
      if (mag > IMPACT_G) { gateState = GateState::ImpactLockout; lockoutStartMs = now; } break;
    case GateState::ImpactLockout:
      if (now - lockoutStartMs >= LOCKOUT_MS) { gateState = GateState::Reacquire; reacquireStartMs = now; } break;
    case GateState::Reacquire:
      if (now - reacquireStartMs >= REACQ_MS) gateState = GateState::UnmutedLive; break;
  }
  if (prev != gateState) { notifyGateState(); drawRuntimeStatus(); }
}

// ── Battery ──────────────────────────────────────────────────────────────
void updateBattery() {
  const uint32_t now = millis();
  if (now - lastBatteryTickMs < 1000) return;
  lastBatteryTickMs = now;
  const uint8_t pct  = M5.Power.getBatteryLevel();
  const bool    chrg = M5.Power.isCharging();
  drawBatteryHud(pct, chrg);
  if (pct != lastBatteryPercent || chrg != lastCharging || (now - lastBatteryNotifyMs) >= 10000) {
    lastBatteryNotifyMs = now;
    lastBatteryPercent  = pct;
    lastCharging        = chrg;
    uint8_t pl[2] = {pct, static_cast<uint8_t>(chrg ? 1 : 0)};
    batteryChar->setValue(pl, sizeof(pl));
    if (canNotify()) rawNotify(batteryChar, pl, sizeof(pl));
  }
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
  while (M5.Mic.isRecording() < 2) {
    if (!M5.Mic.record(micRing[micWriteIndex], AUDIO_SAMPLE_COUNT, AUDIO_SAMPLE_RATE, false)) break;
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

void encodeNewFrame() {
  queueMicCapture();

  const bool talkOpen = (gateState == GateState::UnmutedLive ||
                         gateState == GateState::Reacquire);
  txMutedBit = talkOpen ? 0x00 : 0x80;

  int16_t samples[AUDIO_SAMPLE_COUNT];
  const bool haveMic = popMicFrame(samples);
  if (!(talkOpen && haveMic)) memset(samples, 0, sizeof(samples));

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
    // BLE buffer full – retry on next loop
    return false;
  }

  txSubNext++;
  txLastSubMs = millis();

  if (txSubNext >= TOTAL_SUB) {
    // Frame complete
    if (!firstAudioSent) {
      firstAudioSent = true;
      Serial.printf("[BLE] First audio seq=%u MTU=%u\n",
                    txFrameSeq, ble_att_mtu(bleConnHandle));
      drawRuntimeStatus();
    }
    ++frameSeq;
  }
  return true;
}

void sendMicAudioFrame() {
  if (!canNotify()) return;
  const uint32_t now = millis();

  // If we have a frame in flight, pace the sub-packets
  if (txSubNext < TOTAL_SUB) {
    if (now - txLastSubMs >= SUB_INTERVAL_MS) {
      sendNextSubPacket();
    }
    return;
  }

  // No frame in flight – time for a new one?
  if (now - lastAudioTickMs < 20) return;
  lastAudioTickMs = now;

  encodeNewFrame();
  sendNextSubPacket();  // send sub-packet 0 immediately
}

// ── BLE setup ────────────────────────────────────────────────────────────
void setupBle() {
  NimBLEDevice::init(DEVICE_NAME);
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);
  // Do NOT call setMTU() – server-initiated MTU exchange collides with
  // browser service discovery on Windows BLE stacks, causing disconnects.
  // Our 20-byte sub-packets fit in the default MTU 23.

  bleServer = NimBLEDevice::createServer();
  bleServer->setCallbacks(new ServerCallbacks());
  auto* svc = bleServer->createService(SERVICE_UUID);

  audioChar   = svc->createCharacteristic(AUDIO_CHAR_UUID,   NIMBLE_PROPERTY::NOTIFY, 20);
  batteryChar = svc->createCharacteristic(BATT_CHAR_UUID,    NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  stateChar   = svc->createCharacteristic(STATE_CHAR_UUID,   NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  controlChar = svc->createCharacteristic(CONTROL_CHAR_UUID, NIMBLE_PROPERTY::WRITE);
  controlChar->setCallbacks(new ControlCallbacks());

  svc->start();
  auto* adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(SERVICE_UUID);
  adv->setScanResponse(true);
  adv->start();
}

// ── Arduino entry points ─────────────────────────────────────────────────
void setup() {
  auto cfg = M5.config();
  M5.begin(cfg);

  auto mc = M5.Mic.config();
  mc.sample_rate        = AUDIO_SAMPLE_RATE;
  mc.over_sampling      = 1;
  mc.noise_filter_level = 32;
  mc.magnification      = mc.use_adc ? 16 : 1;
  mc.dma_buf_count      = 8;
  mc.dma_buf_len        = AUDIO_SAMPLE_COUNT;
  M5.Mic.config(mc);
  M5.Speaker.end();
  micAvailable = M5.Mic.isEnabled() && M5.Mic.begin();

  M5.Display.setRotation(1);
  M5.Display.fillScreen(TFT_BLACK);
  M5.Display.setTextSize(2);
  M5.Display.setCursor(4, 24);
  M5.Display.println("TossTalk");

  setupBle();
  drawBatteryHud(M5.Power.getBatteryLevel(), M5.Power.isCharging());
  notifyGateState();
  drawRuntimeStatus();
  queueMicCapture();
}

void loop() {
  // If BLE just connected, avoid SPI/I2C work for a few seconds so the
  // NimBLE stack can handle service discovery without bus contention.
  const bool settling = bleClientConnected &&
                        (millis() - bleConnectedAtMs < BLE_SETTLING_MS);

  if (!settling) {
    M5.update();
    updateGateState();
    updateBattery();
  }

  // Process display updates deferred from BLE callbacks
  if (displayDirty && !settling) {
    displayDirty = false;
    drawRuntimeStatus();
  }

  sendMicAudioFrame();

  // Yield so the NimBLE FreeRTOS task gets CPU on single-core configs
  delay(1);
}
