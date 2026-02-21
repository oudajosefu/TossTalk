const SERVICE_UUID = '9f8d0001-6b7b-4f26-b10f-3aa861aa0001';
const AUDIO_CHAR_UUID = '9f8d0002-6b7b-4f26-b10f-3aa861aa0001';
const BATT_CHAR_UUID = '9f8d0003-6b7b-4f26-b10f-3aa861aa0001';
const STATE_CHAR_UUID = '9f8d0004-6b7b-4f26-b10f-3aa861aa0001';

const AUDIO_CODEC_PCM16 = 0;
const AUDIO_CODEC_IMA_ADPCM = 1;
const FRAME_MS = 20;
const TARGET_BUFFER_FRAMES = 4;
const MAX_BUFFER_FRAMES = 24;
const MAX_CONCEAL_FRAMES_PER_GAP = 8;

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
const firmwareUrlInput = document.getElementById('firmwareUrl');
const firmwareFileInput = document.getElementById('firmwareFile');
const flashAddressInput = document.getElementById('flashAddress');
const eraseAllInput = document.getElementById('eraseAll');
const flashProgress = document.getElementById('flashProgress');
const flashStatus = document.getElementById('flashStatus');
const frameCountEl = document.getElementById('frameCount');
const dropCountEl = document.getElementById('dropCount');
const mutedCountEl = document.getElementById('mutedCount');
const concealedCountEl = document.getElementById('concealedCount');
const bufferDepthEl = document.getElementById('bufferDepth');
const logs = document.getElementById('logs');

let audioContext;
let scheduleAt = 0;
let bleDevice = null;
let reconnectTimer = null;
let lastSeq = null;
let disconnectBound = false;
let jitterTimer = null;
let expectedSeq = null;
let playoutStarted = false;
let streamSampleRate = 8000;
let streamSampleCount = 160;
let lastGoodFrame = null;

const jitterQueue = [];

const ESPTOOL_IMPORT_URLS = [
  'https://esm.sh/esptool-js@0.5.6?bundle',
  'https://esm.sh/esptool-js@0.5.6',
  'https://cdn.skypack.dev/esptool-js@0.5.6',
];
const DEFAULT_FIRMWARE_URL = './firmware/tosstalk-merged.bin';

let esptoolModule = null;

const stats = {
  frames: 0,
  drops: 0,
  mutedFrames: 0,
  concealedFrames: 0,
};

function updateStatsUi() {
  frameCountEl.textContent = String(stats.frames);
  dropCountEl.textContent = String(stats.drops);
  mutedCountEl.textContent = String(stats.mutedFrames);
  concealedCountEl.textContent = String(stats.concealedFrames);
  bufferDepthEl.textContent = String(jitterQueue.length);
}

function log(message) {
  const time = new Date().toLocaleTimeString();
  logs.textContent = `[${time}] ${message}\n` + logs.textContent;
}

function setFlashStatus(text) {
  flashStatus.textContent = text;
  log(`FLASH: ${text}`);
}

function formatError(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (err?.message) return String(err.message);
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function parseAddress(value) {
  const input = value.trim().toLowerCase();
  if (input.startsWith('0x')) return Number.parseInt(input.slice(2), 16);
  return Number.parseInt(input, 10);
}

async function loadEsptoolModule() {
  if (esptoolModule) return esptoolModule;

  let lastError = null;
  for (const url of ESPTOOL_IMPORT_URLS) {
    try {
      esptoolModule = await import(url);
      return esptoolModule;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`Unable to load esptool-js module: ${lastError?.message || 'unknown error'}`);
}

async function loadFirmwareImage() {
  const chosenFile = firmwareFileInput.files?.[0];
  const firmwareUrl = (firmwareUrlInput.value.trim() || DEFAULT_FIRMWARE_URL);

  if (chosenFile) {
    const arrayBuffer = await chosenFile.arrayBuffer();
    return {
      name: chosenFile.name,
      data: new Uint8Array(arrayBuffer),
    };
  }

  const response = await fetch(firmwareUrl, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to fetch firmware URL (${response.status})`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return {
    name: firmwareUrl,
    data: new Uint8Array(arrayBuffer),
  };
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

function resetAudioPipeline() {
  jitterQueue.length = 0;
  expectedSeq = null;
  playoutStarted = false;
  lastGoodFrame = null;
  updateStatsUi();
}

function makeConcealmentFrame(sampleCount) {
  const out = new Int16Array(sampleCount);
  if (!lastGoodFrame || lastGoodFrame.length !== sampleCount) {
    return out;
  }

  for (let i = 0; i < sampleCount; i++) {
    out[i] = (lastGoodFrame[i] * 7) >> 3;
  }
  return out;
}

function enqueueFrame(sampleRate, sampleCount, frame) {
  streamSampleRate = sampleRate;
  streamSampleCount = sampleCount;

  if (jitterQueue.length >= MAX_BUFFER_FRAMES) {
    jitterQueue.shift();
    stats.drops += 1;
  }

  jitterQueue.push(frame);
  updateStatsUi();
}

function ensurePlayoutLoop() {
  if (jitterTimer) return;

  jitterTimer = setInterval(() => {
    ensureAudio();

    if (!playoutStarted) {
      if (jitterQueue.length < TARGET_BUFFER_FRAMES) {
        return;
      }
      playoutStarted = true;
      scheduleAt = Math.max(scheduleAt, audioContext.currentTime + 0.04);
    }

    let frame = jitterQueue.shift();
    if (!frame) {
      frame = makeConcealmentFrame(streamSampleCount);
      stats.concealedFrames += 1;
    }

    playPcm16Samples(streamSampleRate, frame);
    updateStatsUi();
  }, FRAME_MS);
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

  ensurePlayoutLoop();

  if (lastSeq !== null) {
    const delta = (seq - lastSeq + 65536) % 65536;
    if (delta > 1) {
      stats.drops += delta - 1;
    }
  }
  lastSeq = seq;
  stats.frames += 1;

  if (expectedSeq === null) {
    expectedSeq = seq;
  }

  const seqGap = (seq - expectedSeq + 65536) % 65536;
  if (seqGap > 0 && seqGap < 1000) {
    const conceal = Math.min(seqGap, MAX_CONCEAL_FRAMES_PER_GAP);
    for (let i = 0; i < conceal; i++) {
      enqueueFrame(sampleRate, sampleCount, makeConcealmentFrame(sampleCount));
      stats.concealedFrames += 1;
    }
  }
  expectedSeq = (seq + 1) & 0xffff;

  if (flags & 0x01) {
    stats.mutedFrames += 1;
    enqueueFrame(sampleRate, sampleCount, new Int16Array(sampleCount));
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
      lastGoodFrame = pcm;
      enqueueFrame(sampleRate, sampleCount, pcm);
    }
  } else if (codec === AUDIO_CODEC_PCM16 && payload.byteLength >= sampleCount * 2) {
    const pcm = new Int16Array(payload.buffer, payload.byteOffset, sampleCount);
    const cloned = new Int16Array(sampleCount);
    cloned.set(pcm);
    lastGoodFrame = cloned;
    enqueueFrame(sampleRate, sampleCount, cloned);
  } else {
    enqueueFrame(sampleRate, sampleCount, makeConcealmentFrame(sampleCount));
    stats.concealedFrames += 1;
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
      resetAudioPipeline();
      scheduleReconnect();
    });
    disconnectBound = true;
  }

  const server = await device.gatt.connect();
  resetAudioPipeline();
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

  flashBtn.disabled = true;
  flashProgress.value = 0;

  let transport = null;
  try {
    setFlashStatus('Loading esptool-js...');
    const { ESPLoader, Transport } = await loadEsptoolModule();

    setFlashStatus('Reading firmware image...');
    const firmware = await loadFirmwareImage();
    const flashAddress = parseAddress(flashAddressInput.value);
    if (!Number.isFinite(flashAddress) || flashAddress < 0) {
      throw new Error('Invalid flash address. Use decimal or hex (for example 0x0).');
    }

    setFlashStatus('Select ESP serial port...');
    const port = await navigator.serial.requestPort({});

    const terminalAdapter = {
      clean() {
        return;
      },
      writeLine(data) {
        log(String(data));
      },
      write(data) {
        log(String(data));
      },
    };

    transport = new Transport(port, false);
    const loader = new ESPLoader({
      transport,
      baudrate: 115200,
      terminal: terminalAdapter,
      debugLogging: false,
    });

    setFlashStatus('Connecting to chip...');
    const chip = await loader.main('default_reset');
    log(`Connected to chip: ${chip}`);

    setFlashStatus('Writing firmware...');
    await loader.writeFlash({
      fileArray: [{ address: flashAddress, data: firmware.data }],
      flashMode: 'keep',
      flashFreq: 'keep',
      flashSize: 'keep',
      eraseAll: Boolean(eraseAllInput.checked),
      // Some browser/CDN builds of esptool-js can fail in compressed mode.
      // Keep this off for reliability in classroom flows.
      compress: false,
      reportProgress: (_fileIndex, written, total) => {
        const pct = total > 0 ? Math.round((written / total) * 100) : 0;
        flashProgress.value = pct;
        flashStatus.textContent = `Flashing ${pct}%`;
      },
    });

    setFlashStatus('Finalizing and rebooting...');
    await loader.after('hard_reset');
    setFlashStatus(`Flash successful: ${firmware.name}`);
  } catch (err) {
    setFlashStatus(`Flash failed: ${formatError(err)}`);
    throw err;
  } finally {
    flashBtn.disabled = false;
    if (transport) {
      try {
        await transport.disconnect();
      } catch {
        // Ignore disconnect cleanup errors.
      }
    }
  }
}

connectBtn.addEventListener('click', () => connectBle().catch((err) => log(`Connect error: ${err.message}`)));
flashBtn.addEventListener('click', () => startFlashFlow().catch((err) => log(`Flash error: ${err.message}`)));
updateStatsUi();
if (!firmwareUrlInput.value.trim()) {
  firmwareUrlInput.value = DEFAULT_FIRMWARE_URL;
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}