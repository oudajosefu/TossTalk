const SERVICE_UUID = '9f8d0001-6b7b-4f26-b10f-3aa861aa0001';
const AUDIO_CHAR_UUID = '9f8d0002-6b7b-4f26-b10f-3aa861aa0001';
const BATT_CHAR_UUID = '9f8d0003-6b7b-4f26-b10f-3aa861aa0001';
const STATE_CHAR_UUID = '9f8d0004-6b7b-4f26-b10f-3aa861aa0001';

const AUDIO_CODEC_PCM16 = 0;
const AUDIO_CODEC_IMA_ADPCM = 1;

const ADPCM_INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
const ADPCM_STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19,
  21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55,
  60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157,
  173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449,
  494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282,
  1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660,
  4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
  11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
];

const connectBtn = document.getElementById('connectBtn');
const flashBtn = document.getElementById('flashBtn');
const connState = document.getElementById('connState');
const gateState = document.getElementById('gateState');
const battery = document.getElementById('battery');
const frameCountEl = document.getElementById('frameCount');
const dropCountEl = document.getElementById('dropCount');
const mutedCountEl = document.getElementById('mutedCount');
const logs = document.getElementById('logs');

let audioContext;
let scheduleAt = 0;
let bleDevice = null;
let reconnectTimer = null;
let lastSeq = null;
let disconnectBound = false;

const stats = {
  frames: 0,
  drops: 0,
  mutedFrames: 0,
};

function updateStatsUi() {
  frameCountEl.textContent = String(stats.frames);
  dropCountEl.textContent = String(stats.drops);
  mutedCountEl.textContent = String(stats.mutedFrames);
}

function log(message) {
  const time = new Date().toLocaleTimeString();
  logs.textContent = `[${time}] ${message}\n` + logs.textContent;
}

function gateName(v) {
  switch (v) {
    case 0:
      return 'UnmutedLive';
    case 1:
      return 'AirborneSuppressed';
    case 2:
      return 'ImpactLockout';
    case 3:
      return 'Reacquire';
    default:
      return `Unknown(${v})`;
  }
}

function ensureAudio() {
  if (!audioContext) {
    audioContext = new AudioContext({ sampleRate: 48000 });
    scheduleAt = audioContext.currentTime;
  }
}

function playPcm16(sampleRate, pcmBytes) {
  ensureAudio();

  const int16 = new Int16Array(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength / 2);
  const floatData = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    floatData[i] = int16[i] / 32768;
  }

  const buffer = audioContext.createBuffer(1, floatData.length, sampleRate);
  buffer.copyToChannel(floatData, 0);

  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);

  const now = audioContext.currentTime;
  scheduleAt = Math.max(scheduleAt, now + 0.02);
  source.start(scheduleAt);
  scheduleAt += buffer.duration;
}

function playPcm16Samples(sampleRate, int16) {
  ensureAudio();

  const floatData = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    floatData[i] = int16[i] / 32768;
  }

  const buffer = audioContext.createBuffer(1, floatData.length, sampleRate);
  buffer.copyToChannel(floatData, 0);

  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);

  const now = audioContext.currentTime;
  scheduleAt = Math.max(scheduleAt, now + 0.02);
  source.start(scheduleAt);
  scheduleAt += buffer.duration;
}

function decodeImaAdpcm(data, sampleCount, predictor, index) {
  const out = new Int16Array(sampleCount);
  let pred = predictor;
  let idx = Math.min(88, Math.max(0, index));
  let o = 0;

  for (let i = 0; i < data.length && o < sampleCount; i++) {
    const byte = data[i];
    const n0 = byte & 0x0f;
    const n1 = (byte >> 4) & 0x0f;

    for (const nibble of [n0, n1]) {
      let step = ADPCM_STEP_TABLE[idx];
      let diff = step >> 3;
      if (nibble & 0x01) diff += step >> 2;
      if (nibble & 0x02) diff += step >> 1;
      if (nibble & 0x04) diff += step;

      if (nibble & 0x08) pred -= diff;
      else pred += diff;

      pred = Math.max(-32768, Math.min(32767, pred));
      idx += ADPCM_INDEX_TABLE[nibble];
      idx = Math.max(0, Math.min(88, idx));

      out[o++] = pred;
      if (o >= sampleCount) break;
    }
  }

  return out;
}

function handleAudioFrame(event) {
  const dv = event.target.value;
  if (!dv || dv.byteLength < 8) return;

  const seq = dv.getUint16(0, true);
  const sampleRate = dv.getUint16(2, true);
  const sampleCount = dv.getUint8(4);
  const flags = dv.getUint8(5);
  const codec = dv.getUint8(6);
  const payload = new Uint8Array(dv.buffer, dv.byteOffset + 8, dv.byteLength - 8);

  if (lastSeq !== null) {
    const delta = (seq - lastSeq + 65536) % 65536;
    if (delta > 1) {
      stats.drops += delta - 1;
    }
  }
  lastSeq = seq;
  stats.frames += 1;

  if (flags & 0x01) {
    stats.mutedFrames += 1;
    updateStatsUi();
    return;
  }

  if (codec === AUDIO_CODEC_IMA_ADPCM) {
    if (payload.byteLength >= 4) {
      const headerOffset = dv.byteOffset + 8;
      const predictor = dv.getInt16(8, true);
      const index = dv.getUint8(10);
      const adpcm = new Uint8Array(dv.buffer, headerOffset + 4, dv.byteLength - 12);
      const pcm = decodeImaAdpcm(adpcm, sampleCount, predictor, index);
      playPcm16Samples(sampleRate, pcm);
    }
  } else if (codec === AUDIO_CODEC_PCM16 && payload.byteLength >= sampleCount * 2) {
    playPcm16(sampleRate, payload);
  }

  updateStatsUi();

  if (seq % 50 === 0) {
    log(`Audio seq=${seq} sr=${sampleRate} samples=${sampleCount}`);
  }
}

function handleBattery(event) {
  const dv = event.target.value;
  if (!dv || dv.byteLength < 2) return;
  const pct = dv.getUint8(0);
  const charging = dv.getUint8(1) === 1;
  battery.textContent = `${pct}%${charging ? ' (charging)' : ''}`;
}

function handleState(event) {
  const dv = event.target.value;
  if (!dv || dv.byteLength < 1) return;
  const state = dv.getUint8(0);
  gateState.textContent = gateName(state);
}

async function connectBle() {
  if (!('bluetooth' in navigator)) {
    alert('Web Bluetooth unavailable in this browser. Use desktop Chromium.');
    return;
  }

  connState.textContent = 'Selecting device...';
  const device = bleDevice || (await navigator.bluetooth.requestDevice({
    filters: [{ services: [SERVICE_UUID] }],
    optionalServices: [SERVICE_UUID],
  }));
  bleDevice = device;

  if (!disconnectBound) {
    device.addEventListener('gattserverdisconnected', () => {
      connState.textContent = 'Disconnected';
      log('BLE disconnected');
      scheduleReconnect();
    });
    disconnectBound = true;
  }

  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(SERVICE_UUID);

  const audioChar = await service.getCharacteristic(AUDIO_CHAR_UUID);
  const battChar = await service.getCharacteristic(BATT_CHAR_UUID);
  const stateChar = await service.getCharacteristic(STATE_CHAR_UUID);

  await Promise.all([
    audioChar.startNotifications(),
    battChar.startNotifications(),
    stateChar.startNotifications(),
  ]);

  audioChar.addEventListener('characteristicvaluechanged', handleAudioFrame);
  battChar.addEventListener('characteristicvaluechanged', handleBattery);
  stateChar.addEventListener('characteristicvaluechanged', handleState);

  const battNow = await battChar.readValue();
  handleBattery({ target: { value: battNow } });
  const stateNow = await stateChar.readValue();
  handleState({ target: { value: stateNow } });

  clearReconnect();
  connState.textContent = `Connected: ${device.name || 'TossTalk'}`;
  log('BLE connected and notifications active');
}

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  if (!bleDevice || reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      connState.textContent = 'Reconnecting...';
      await connectBle();
      log('BLE auto-reconnect success');
    } catch (err) {
      log(`BLE auto-reconnect failed: ${err.message}`);
      scheduleReconnect();
    }
  }, 1500);
}

async function startFlashFlow() {
  if (!('serial' in navigator)) {
    alert('Web Serial unavailable. Use a Chromium desktop browser.');
    return;
  }

  // Bootstrap only. Full esptool-js integration lands in next milestone.
  const port = await navigator.serial.requestPort();
  await port.open({ baudRate: 115200 });
  const info = port.getInfo();
  log(`Serial port opened VID=${info.usbVendorId || 0} PID=${info.usbProductId || 0}`);
  log('Flashing data transfer integration is the next step (esptool-js).');
  await port.close();
}

connectBtn.addEventListener('click', () => connectBle().catch((err) => log(`Connect error: ${err.message}`)));
flashBtn.addEventListener('click', () => startFlashFlow().catch((err) => log(`Flash error: ${err.message}`)));
updateStatsUi();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}