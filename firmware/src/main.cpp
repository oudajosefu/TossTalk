#include <M5Unified.h>
#include <NimBLEDevice.h>

#include <cmath>

static const char* DEVICE_NAME = "TossTalk";

static const char* SERVICE_UUID = "9f8d0001-6b7b-4f26-b10f-3aa861aa0001";
static const char* AUDIO_CHAR_UUID = "9f8d0002-6b7b-4f26-b10f-3aa861aa0001";
static const char* BATT_CHAR_UUID = "9f8d0003-6b7b-4f26-b10f-3aa861aa0001";
static const char* STATE_CHAR_UUID = "9f8d0004-6b7b-4f26-b10f-3aa861aa0001";
static const char* CONTROL_CHAR_UUID = "9f8d0005-6b7b-4f26-b10f-3aa861aa0001";

enum class GateState : uint8_t {
  UnmutedLive = 0,
  AirborneSuppressed = 1,
  ImpactLockout = 2,
  Reacquire = 3,
};

NimBLEServer* bleServer = nullptr;
NimBLECharacteristic* audioChar = nullptr;
NimBLECharacteristic* batteryChar = nullptr;
NimBLECharacteristic* stateChar = nullptr;
NimBLECharacteristic* controlChar = nullptr;

GateState gateState = GateState::UnmutedLive;
uint32_t lockoutStartMs = 0;
uint32_t reacquireStartMs = 0;
uint32_t lastBatteryTickMs = 0;
uint32_t lastBatteryNotifyMs = 0;
uint32_t lastAudioTickMs = 0;
uint32_t seq = 0;

bool bleClientConnected = false;
bool micAvailable = false;

static constexpr uint16_t AUDIO_SAMPLE_RATE = 8000;
static constexpr uint8_t AUDIO_SAMPLE_COUNT = 160;  // 20 ms @ 8 kHz
static constexpr size_t MIC_RING_SIZE = 4;
int16_t micRing[MIC_RING_SIZE][AUDIO_SAMPLE_COUNT] = {};
size_t micWriteIndex = 0;
size_t micReadIndex = 0;
size_t micQueued = 0;

uint8_t lastBatteryPercent = 0;
bool lastCharging = false;

void notifyGateState();

const char* gateStateName(GateState s) {
  switch (s) {
    case GateState::UnmutedLive:
      return "UnmutedLive";
    case GateState::AirborneSuppressed:
      return "AirborneSuppressed";
    case GateState::ImpactLockout:
      return "ImpactLockout";
    case GateState::Reacquire:
      return "Reacquire";
  }
  return "Unknown";
}

void drawRuntimeStatus() {
  M5.Display.fillRect(0, 50, M5.Display.width(), 66, TFT_BLACK);
  M5.Display.setTextColor(TFT_CYAN, TFT_BLACK);
  M5.Display.setCursor(4, 54);
  M5.Display.printf("%s", gateStateName(gateState));
  M5.Display.setCursor(4, 74);
  M5.Display.printf("BLE %s", bleClientConnected ? "connected" : "waiting");
  M5.Display.setCursor(4, 94);
  M5.Display.printf("MIC %s", micAvailable ? "ready" : "not-ready");
}

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* pServer) {
    (void)pServer;
    bleClientConnected = true;
    drawRuntimeStatus();
  }

  void onDisconnect(NimBLEServer* pServer) {
    bleClientConnected = false;
    drawRuntimeStatus();
    pServer->startAdvertising();
  }
};

class ControlCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* pCharacteristic) {
    std::string value = pCharacteristic->getValue();
    if (value == "ping") {
      gateState = GateState::Reacquire;
      reacquireStartMs = millis();
      notifyGateState();
      drawRuntimeStatus();
    }
  }
};

float readAccelMagnitudeG() {
  // M5Unified API varies by board/lib version. Try runtime update and
  // default to 1g on unavailable sensor data.
  if (M5.Imu.update()) {
    auto data = M5.Imu.getImuData();
    const float ax = data.accel.x;
    const float ay = data.accel.y;
    const float az = data.accel.z;
    return std::sqrt(ax * ax + ay * ay + az * az);
  }
  return 1.0f;
}

void notifyGateState() {
  uint8_t payload[2] = {static_cast<uint8_t>(gateState), 0};
  stateChar->setValue(payload, sizeof(payload));
  stateChar->notify();
}

void updateGateState() {
  const uint32_t now = millis();
  const float magG = readAccelMagnitudeG();

  constexpr float AIRBORNE_G = 0.35f;
  constexpr float IMPACT_G = 2.20f;
  constexpr uint32_t IMPACT_LOCKOUT_MS = 120;
  constexpr uint32_t REACQUIRE_MS = 150;

  GateState prev = gateState;

  switch (gateState) {
    case GateState::UnmutedLive:
      if (magG < AIRBORNE_G) {
        gateState = GateState::AirborneSuppressed;
      }
      break;
    case GateState::AirborneSuppressed:
      if (magG > IMPACT_G) {
        gateState = GateState::ImpactLockout;
        lockoutStartMs = now;
      }
      break;
    case GateState::ImpactLockout:
      if (now - lockoutStartMs >= IMPACT_LOCKOUT_MS) {
        gateState = GateState::Reacquire;
        reacquireStartMs = now;
      }
      break;
    case GateState::Reacquire:
      if (now - reacquireStartMs >= REACQUIRE_MS) {
        gateState = GateState::UnmutedLive;
      }
      break;
  }

  if (prev != gateState) {
    notifyGateState();
    drawRuntimeStatus();
  }
}

void drawBatteryHud(uint8_t percent, bool charging) {
  uint16_t color = TFT_WHITE;
  if (percent <= 10) {
    color = TFT_RED;
  } else if (percent <= 20) {
    color = TFT_YELLOW;
  }

  M5.Display.setTextColor(color, TFT_BLACK);
  M5.Display.fillRect(0, 0, M5.Display.width(), 18, TFT_BLACK);
  M5.Display.setCursor(4, 4);
  M5.Display.printf("BAT %3u%% %s", percent, charging ? "CHG" : "   ");
}

void updateBattery() {
  const uint32_t now = millis();
  if (now - lastBatteryTickMs < 1000) return;
  lastBatteryTickMs = now;

  const uint8_t percent = M5.Power.getBatteryLevel();
  const bool charging = M5.Power.isCharging();

  drawBatteryHud(percent, charging);

  const bool changed = (percent != lastBatteryPercent || charging != lastCharging);
  const bool periodic = (now - lastBatteryNotifyMs) >= 10000;

  if (changed || periodic) {
    lastBatteryNotifyMs = now;
    lastBatteryPercent = percent;
    lastCharging = charging;

    uint8_t payload[2] = {percent, static_cast<uint8_t>(charging ? 1 : 0)};
    batteryChar->setValue(payload, sizeof(payload));
    batteryChar->notify();
  }
}

void queueMicCapture() {
  if (!micAvailable) return;

  while (M5.Mic.isRecording() < 2) {
    if (!M5.Mic.record(micRing[micWriteIndex], AUDIO_SAMPLE_COUNT, AUDIO_SAMPLE_RATE, false)) {
      break;
    }

    micWriteIndex = (micWriteIndex + 1) % MIC_RING_SIZE;
    if (micQueued < MIC_RING_SIZE) {
      ++micQueued;
    } else {
      micReadIndex = (micReadIndex + 1) % MIC_RING_SIZE;
    }
  }
}

bool popMicFrame(int16_t* outSamples) {
  if (!micAvailable || micQueued <= 1) {
    for (size_t i = 0; i < AUDIO_SAMPLE_COUNT; ++i) {
      outSamples[i] = 0;
    }
    return false;
  }

  const int16_t* src = micRing[micReadIndex];
  for (size_t i = 0; i < AUDIO_SAMPLE_COUNT; ++i) {
    outSamples[i] = src[i];
  }

  micReadIndex = (micReadIndex + 1) % MIC_RING_SIZE;
  --micQueued;
  return true;
}

void sendMicAudioFrame() {
  const uint32_t now = millis();
  if (now - lastAudioTickMs < 20) return;
  lastAudioTickMs = now;

  queueMicCapture();

  const bool talkOpen = (gateState == GateState::UnmutedLive || gateState == GateState::Reacquire);
  uint8_t flags = 0;
  if (!talkOpen) flags |= 0x01;
  if (!micAvailable) flags |= 0x02;

  uint8_t frame[2 + 2 + 1 + 1 + AUDIO_SAMPLE_COUNT * 2];
  frame[0] = static_cast<uint8_t>(seq & 0xFF);
  frame[1] = static_cast<uint8_t>((seq >> 8) & 0xFF);
  frame[2] = static_cast<uint8_t>(AUDIO_SAMPLE_RATE & 0xFF);
  frame[3] = static_cast<uint8_t>((AUDIO_SAMPLE_RATE >> 8) & 0xFF);
  frame[4] = AUDIO_SAMPLE_COUNT;
  frame[5] = flags;

  int16_t samples[AUDIO_SAMPLE_COUNT];
  const bool haveMicFrame = popMicFrame(samples);

  for (size_t i = 0; i < AUDIO_SAMPLE_COUNT; ++i) {
    int16_t sample = 0;
    if (talkOpen && haveMicFrame) {
      sample = samples[i];
    }
    frame[6 + i * 2] = static_cast<uint8_t>(sample & 0xFF);
    frame[6 + i * 2 + 1] = static_cast<uint8_t>((sample >> 8) & 0xFF);
  }

  audioChar->setValue(frame, sizeof(frame));
  audioChar->notify();
  ++seq;
}

void setupBle() {
  NimBLEDevice::init(DEVICE_NAME);
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);

  bleServer = NimBLEDevice::createServer();
  bleServer->setCallbacks(new ServerCallbacks());
  auto* service = bleServer->createService(SERVICE_UUID);

  audioChar = service->createCharacteristic(AUDIO_CHAR_UUID, NIMBLE_PROPERTY::NOTIFY);
  batteryChar = service->createCharacteristic(
      BATT_CHAR_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  stateChar = service->createCharacteristic(
      STATE_CHAR_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  controlChar = service->createCharacteristic(CONTROL_CHAR_UUID, NIMBLE_PROPERTY::WRITE);
  controlChar->setCallbacks(new ControlCallbacks());

  service->start();
  auto* adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(SERVICE_UUID);
  adv->setScanResponse(true);
  adv->start();
}

void setup() {
  auto cfg = M5.config();
  M5.begin(cfg);

  auto micCfg = M5.Mic.config();
  micCfg.sample_rate = AUDIO_SAMPLE_RATE;
  micCfg.over_sampling = 1;
  micCfg.noise_filter_level = 32;
  micCfg.magnification = micCfg.use_adc ? 16 : 1;
  micCfg.dma_buf_count = 8;
  micCfg.dma_buf_len = AUDIO_SAMPLE_COUNT;
  M5.Mic.config(micCfg);

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
  M5.update();
  updateGateState();
  updateBattery();
  sendMicAudioFrame();
}