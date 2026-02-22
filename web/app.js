// TossTalk – browser console
//
// Architecture v2 – small-packet reassembly
// ------------------------------------------
// The device sends 5 BLE notifications per 20-ms audio frame, each <= 20
// bytes (fits in the default 23-byte ATT MTU).  This file reassembles them
// into complete frames for playback.
//
// Sub-packet layout:
//   Packet 0  (20 bytes): [seq][0x00|muted][pred_lo][pred_hi][idx][adpcm x15]
//   Packets 1-3 (20 bytes): [seq][n|muted][adpcm x18]
//   Packet 4  (13 bytes): [seq][0x04|muted][adpcm x11]
//
// 30 + 36*3 + 22 = 160 samples per frame.

// ── BLE UUIDs ────────────────────────────────────────────────────────────
const SERVICE_UUID    = '9f8d0001-6b7b-4f26-b10f-3aa861aa0001';
const AUDIO_CHAR_UUID = '9f8d0002-6b7b-4f26-b10f-3aa861aa0001';
const BATT_CHAR_UUID  = '9f8d0003-6b7b-4f26-b10f-3aa861aa0001';
const STATE_CHAR_UUID = '9f8d0004-6b7b-4f26-b10f-3aa861aa0001';

// ── Audio constants ──────────────────────────────────────────────────────
const SAMPLE_RATE   = 8000;
const SAMPLE_COUNT  = 160;
const FRAME_MS      = 20;
const SUB_PACKETS   = 5;
const TARGET_BUFFER = 6;   // frames before playout begins (higher = fewer underruns)
const MAX_BUFFER    = 24;
const MAX_CONCEAL   = 8;

// ── ADPCM tables ─────────────────────────────────────────────────────────
const INDEX_TABLE = [-1,-1,-1,-1,2,4,6,8,-1,-1,-1,-1,2,4,6,8];
const STEP_TABLE  = [
  7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,
  60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,
  337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,
  1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,
  5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,
  18500,20350,22385,24623,27086,29794,32767,
];

// ── DOM elements ─────────────────────────────────────────────────────────
const connectBtn      = document.getElementById('connectBtn');
const flashBtn        = document.getElementById('flashBtn');
const connState       = document.getElementById('connState');
const gateStateEl     = document.getElementById('gateState');
const batteryEl       = document.getElementById('battery');
const firmwareUrlIn   = document.getElementById('firmwareUrl');
const firmwareFileIn  = document.getElementById('firmwareFile');
const flashAddressIn  = document.getElementById('flashAddress');
const eraseAllIn      = document.getElementById('eraseAll');
const flashProgress   = document.getElementById('flashProgress');
const flashStatus     = document.getElementById('flashStatus');
const frameCountEl    = document.getElementById('frameCount');
const dropCountEl     = document.getElementById('dropCount');
const mutedCountEl    = document.getElementById('mutedCount');
const concealedCountEl = document.getElementById('concealedCount');
const bufferDepthEl   = document.getElementById('bufferDepth');
const logs            = document.getElementById('logs');

// ── State ────────────────────────────────────────────────────────────────
let audioCtx;
let scheduleAt = 0;
let bleDevice = null;
let reconnectTimer = null;
let disconnectBound = false;
let isConnecting = false;
let jitterTimer = null;
let playoutStarted = false;
let lastGoodFrame = null;
let lastAudioAt = 0;
let noAudioTimer = null;

const jitterQueue = [];

// Sub-packet reassembly buffer
let assemblySeq  = null;   // frame_seq we're currently building
let assemblyPkts = 0;      // bitmask of received sub-packet indices
let assemblyAdpcm = null;  // Uint8Array(80) – concatenated ADPCM data
let assemblyPred = 0;
let assemblyIdx  = 0;
let assemblyMuted = false;
let lastCompleteSeq = null;

const ESPTOOL_URLS = [
  'https://esm.sh/esptool-js@0.5.6?bundle',
  'https://esm.sh/esptool-js@0.5.6',
  'https://cdn.skypack.dev/esptool-js@0.5.6',
];
const DEFAULT_FW_URL = './firmware/tosstalk-merged.bin';
let esptoolMod = null;

const stats = { frames: 0, drops: 0, mutedFrames: 0, concealedFrames: 0, subPkts: 0 };

function updateStatsUi() {
  frameCountEl.textContent   = String(stats.frames);
  dropCountEl.textContent    = String(stats.drops);
  mutedCountEl.textContent   = String(stats.mutedFrames);
  concealedCountEl.textContent = String(stats.concealedFrames);
  bufferDepthEl.textContent  = String(jitterQueue.length);
}

function log(msg) {
  const t = new Date().toLocaleTimeString();
  logs.textContent = `[${t}] ${msg}\n` + logs.textContent;
}

function withTimeout(promise, ms, label) {
  let tid;
  const to = new Promise((_, rej) => { tid = setTimeout(() => rej(new Error(`${label} timed out (${ms}ms)`)), ms); });
  return Promise.race([promise, to]).finally(() => clearTimeout(tid));
}

function formatError(e) {
  if (!e) return 'Unknown';
  if (typeof e === 'string') return e;
  if (e?.message) return String(e.message);
  try { return JSON.stringify(e); } catch { return String(e); }
}

// ── No-audio watchdog ────────────────────────────────────────────────────
function clearNoAudioMonitor() { if (noAudioTimer) { clearInterval(noAudioTimer); noAudioTimer = null; } }
function startNoAudioMonitor() {
  clearNoAudioMonitor();
  lastAudioAt = Date.now();
  noAudioTimer = setInterval(() => {
    if (Date.now() - lastAudioAt > 6000) {
      log(`No audio sub-packets for 6 s (${stats.subPkts} total). Check device.`);
      lastAudioAt = Date.now();
    }
  }, 2000);
}

// ── Audio engine ─────────────────────────────────────────────────────────
function ensureAudio() {
  if (!audioCtx) { audioCtx = new AudioContext({ sampleRate: 48000 }); scheduleAt = audioCtx.currentTime; }
}

function playPcm(rate, int16) {
  ensureAudio();
  const f = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) f[i] = int16[i] / 32768;
  const buf = audioCtx.createBuffer(1, f.length, rate);
  buf.copyToChannel(f, 0);
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.connect(audioCtx.destination);
  const now = audioCtx.currentTime;
  if (scheduleAt < now) scheduleAt = now;        // don't schedule in the past
  src.start(scheduleAt);
  scheduleAt += buf.duration;
}

function resetAudioPipeline() {
  jitterQueue.length = 0;
  playoutStarted = false;
  lastGoodFrame = null;
  assemblySeq = null;
  assemblyPkts = 0;
  assemblyAdpcm = null;
  lastCompleteSeq = null;
  updateStatsUi();
}

function makeConceal(n) {
  // Return silence — repeating the last frame creates an audible buzz
  return new Int16Array(n);
}

function enqueue(frame) {
  if (jitterQueue.length >= MAX_BUFFER) { jitterQueue.shift(); stats.drops++; }
  jitterQueue.push(frame);
  updateStatsUi();
}

function ensurePlayoutLoop() {
  if (jitterTimer) return;
  jitterTimer = setInterval(() => {
    ensureAudio();
    if (!playoutStarted) {
      if (jitterQueue.length < TARGET_BUFFER) return;
      playoutStarted = true;
      scheduleAt = audioCtx.currentTime + 0.08;  // 80ms lead-in
    }
    // Only consume when scheduled audio is about to run out (< 60ms ahead)
    const ahead = scheduleAt - audioCtx.currentTime;
    if (ahead > 0.06) return;                    // plenty buffered in Web Audio
    // Drain up to 2 frames per tick to catch up if needed
    const drain = Math.min(2, jitterQueue.length || 1);
    for (let d = 0; d < drain; d++) {
      let frame = jitterQueue.shift();
      if (!frame) { frame = makeConceal(SAMPLE_COUNT); stats.concealedFrames++; }
      else { lastGoodFrame = frame; }
      playPcm(SAMPLE_RATE, frame);
    }
    updateStatsUi();
  }, FRAME_MS);
}

// ── IMA ADPCM decoder ───────────────────────────────────────────────────
function decodeAdpcm(data, count, predictor, index) {
  const out = new Int16Array(count);
  let pred = predictor, idx = Math.min(88, Math.max(0, index)), o = 0;
  for (let i = 0; i < data.length && o < count; i++) {
    const b = data[i];
    for (const nib of [b & 0x0f, (b >> 4) & 0x0f]) {
      let step = STEP_TABLE[idx], diff = step >> 3;
      if (nib & 1) diff += step >> 2;
      if (nib & 2) diff += step >> 1;
      if (nib & 4) diff += step;
      pred += (nib & 8) ? -diff : diff;
      pred = Math.max(-32768, Math.min(32767, pred));
      idx += INDEX_TABLE[nib]; idx = Math.max(0, Math.min(88, idx));
      out[o++] = pred;
      if (o >= count) break;
    }
  }
  return out;
}

// ── Sub-packet reassembly ────────────────────────────────────────────────
// Each BLE notification is one sub-packet. We collect 5 per frame_seq,
// then decode the combined ADPCM into 160 PCM samples and enqueue.

function resetAssembly() {
  assemblySeq   = null;
  assemblyPkts  = 0;
  assemblyAdpcm = new Uint8Array(80);
  assemblyPred  = 0;
  assemblyIdx   = 0;
  assemblyMuted = false;
}

function finalizeFrame() {
  if (assemblyMuted) {
    enqueue(new Int16Array(SAMPLE_COUNT));
    stats.mutedFrames++;
  } else {
    const pcm = decodeAdpcm(assemblyAdpcm, SAMPLE_COUNT, assemblyPred, assemblyIdx);
    lastGoodFrame = pcm;
    enqueue(pcm);
  }
  stats.frames++;

  // Insert concealment for any skipped frame_seqs
  if (lastCompleteSeq !== null) {
    let gap = ((assemblySeq - lastCompleteSeq + 256) % 256) - 1;
    if (gap > 0 && gap < 60) {
      const conceal = Math.min(gap, MAX_CONCEAL);
      for (let i = 0; i < conceal; i++) { enqueue(makeConceal(SAMPLE_COUNT)); stats.concealedFrames++; }
    }
  }
  lastCompleteSeq = assemblySeq;
  ensurePlayoutLoop();
}

function handleAudioSubPacket(event) {
  const dv = event.target.value;
  if (!dv || dv.byteLength < 2) return;
  lastAudioAt = Date.now();
  stats.subPkts++;

  const seq     = dv.getUint8(0);
  const byte1   = dv.getUint8(1);
  const pktIdx  = byte1 & 0x0F;
  const muted   = !!(byte1 & 0x80);

  // Log first few packets for diagnostics
  if (stats.subPkts <= 5) {
    log(`Pkt #${stats.subPkts}: seq=${seq} idx=${pktIdx} len=${dv.byteLength} muted=${muted}`);
  }

  // ── Single-packet mode (85 bytes = full frame in one notification) ────
  if (pktIdx === 0 && dv.byteLength >= 85) {
    // Finalize any in-progress assembly from a previous sub-packet stream
    if (assemblySeq !== null && assemblyPkts !== 0) finalizeFrame();
    resetAssembly();

    const pred  = dv.getInt16(2, true);
    const idx   = dv.getUint8(4);
    const adpcm = new Uint8Array(dv.buffer, dv.byteOffset + 5, 80);

    if (muted) {
      enqueue(new Int16Array(SAMPLE_COUNT));
      stats.mutedFrames++;
    } else {
      const pcm = decodeAdpcm(adpcm, SAMPLE_COUNT, pred, idx);
      lastGoodFrame = pcm;
      enqueue(pcm);
    }
    stats.frames++;

    if (stats.frames <= 3) {
      log(`Frame #${stats.frames} (single-pkt): seq=${seq} pred=${pred} idx=${idx} muted=${muted}`);
    }

    // Concealment for any skipped sequences
    if (lastCompleteSeq !== null) {
      let gap = ((seq - lastCompleteSeq + 256) % 256) - 1;
      if (gap > 0 && gap < 60) {
        const conceal = Math.min(gap, MAX_CONCEAL);
        for (let i = 0; i < conceal; i++) { enqueue(makeConceal(SAMPLE_COUNT)); stats.concealedFrames++; }
      }
    }
    lastCompleteSeq = seq;
    ensurePlayoutLoop();
    updateStatsUi();
    return;
  }

  // ── Sub-packet mode (≤20 bytes, 5 packets per frame) ──────────────────
  if (seq !== assemblySeq) {
    if (assemblySeq !== null && assemblyPkts !== 0) {
      // Previous frame was incomplete – finalize what we have
      finalizeFrame();
    }
    resetAssembly();
    assemblySeq = seq;
  }

  assemblyMuted = assemblyMuted || muted;

  if (pktIdx === 0 && dv.byteLength >= 20) {
    // Header packet – extract predictor + index
    assemblyPred = dv.getInt16(2, true);
    assemblyIdx  = dv.getUint8(4);
    // Copy 15 ADPCM bytes at offset 0
    const src = new Uint8Array(dv.buffer, dv.byteOffset + 5, 15);
    assemblyAdpcm.set(src, 0);
    assemblyPkts |= 1;
  } else if (pktIdx >= 1 && pktIdx <= 3 && dv.byteLength >= 20) {
    // Middle packets – 18 ADPCM bytes each
    const adpcmOffset = 15 + (pktIdx - 1) * 18;
    const src = new Uint8Array(dv.buffer, dv.byteOffset + 2, 18);
    assemblyAdpcm.set(src, adpcmOffset);
    assemblyPkts |= (1 << pktIdx);
  } else if (pktIdx === 4 && dv.byteLength >= 13) {
    // Tail packet – 11 ADPCM bytes
    const adpcmOffset = 15 + 3 * 18;  // = 69
    const src = new Uint8Array(dv.buffer, dv.byteOffset + 2, 11);
    assemblyAdpcm.set(src, adpcmOffset);
    assemblyPkts |= (1 << 4);
  }

  // Log first few complete frames
  if (stats.frames < 5 && assemblyPkts === 0x1F) {
    log(`Frame #${stats.frames + 1} complete: seq=${seq}, muted=${muted}, pred=${assemblyPred}, idx=${assemblyIdx}`);
  }

  // All 5 sub-packets received?
  if (assemblyPkts === 0x1F) {
    finalizeFrame();
    resetAssembly();
  }

  updateStatsUi();
}

// ── Battery / State handlers ─────────────────────────────────────────────
function handleBattery(event) {
  const dv = event.target.value;
  if (!dv || dv.byteLength < 2) return;
  const pct = dv.getUint8(0), chrg = dv.getUint8(1) === 1;
  batteryEl.textContent = `${pct}%${chrg ? ' (charging)' : ''}`;
}

function handleState(event) {
  const dv = event.target.value;
  if (!dv || dv.byteLength < 1) return;
  const names = ['UnmutedLive','AirborneSuppressed','ImpactLockout','Reacquire'];
  gateStateEl.textContent = names[dv.getUint8(0)] || `Unknown(${dv.getUint8(0)})`;
}

// ── BLE connect ──────────────────────────────────────────────────────────
async function connectBle() {
  if (isConnecting) { log('Connect already in progress'); return; }
  let server = null;
  isConnecting = true;
  try {
    if (!('bluetooth' in navigator)) {
      const msg = [
        'Web Bluetooth unavailable.',
        !window.isSecureContext ? 'Page is not HTTPS.' : '',
        'Use Chrome or Edge desktop over HTTPS.',
      ].filter(Boolean).join(' ');
      connState.textContent = 'Unavailable';
      alert(msg);
      return;
    }

    connState.textContent = 'Selecting device...';
    const device = bleDevice || (await withTimeout(
      navigator.bluetooth.requestDevice({ filters: [{ services: [SERVICE_UUID] }], optionalServices: [SERVICE_UUID] }),
      30000, 'Device picker'
    ));
    bleDevice = device;

    if (!disconnectBound) {
      device.addEventListener('gattserverdisconnected', () => {
        connState.textContent = 'Disconnected';
        log('BLE disconnected');
        resetAudioPipeline();
        clearNoAudioMonitor();
        if (!isConnecting) scheduleReconnect();
      });
      disconnectBound = true;
    }

    let service = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        connState.textContent = attempt === 1 ? 'Connecting...' : 'Reconnecting...';
        if (!device.gatt.connected) {
          server = await withTimeout(device.gatt.connect(), 15000, 'GATT connect');
        } else {
          server = device.gatt;
        }
        resetAudioPipeline();

        // Give the device 3 seconds to settle — the firmware's loop() yields
        // 100 % of CPU to the NimBLE stack for 5 s after connect so that
        // service discovery can complete without bus contention.
        connState.textContent = 'Waiting for device to settle...';
        await new Promise(r => setTimeout(r, 3000));

        for (let st = 1; st <= 3; st++) {
          connState.textContent = `Service discovery (${st}/3)...`;
          try {
            service = await withTimeout(server.getPrimaryService(SERVICE_UUID), 10000, 'Service');
            break;
          } catch (e) {
            log(`Service try ${st}/3 failed: ${formatError(e)}`);
            if (!device.gatt.connected) {
              log('⚠️ Connection lost during discovery. The device generates a new ' +
                  'BLE address on each boot — try power-cycling the device and reconnecting.');
              await new Promise(r => setTimeout(r, 1000));
              server = await withTimeout(device.gatt.connect(), 12000, 'GATT reconnect');
              await new Promise(r => setTimeout(r, 3000));
            }
            if (st === 3) throw e;
          }
        }
        break;
      } catch (e) {
        log(`Attempt ${attempt} failed: ${formatError(e)}`);
        if (attempt < 2) { await new Promise(r => setTimeout(r, 500)); continue; }
        throw e;
      }
    }
    if (!service) throw new Error('Service resolution failed');

    connState.textContent = 'Getting characteristics...';
    const [audioChar, battChar, stateChar] = await withTimeout(
      Promise.all([
        service.getCharacteristic(AUDIO_CHAR_UUID),
        service.getCharacteristic(BATT_CHAR_UUID),
        service.getCharacteristic(STATE_CHAR_UUID),
      ]), 8000, 'Characteristics'
    );

    connState.textContent = 'Starting notifications...';
    await withTimeout(battChar.startNotifications(),  7000, 'Battery notif');
    log('Battery notifications on');
    await withTimeout(stateChar.startNotifications(), 7000, 'State notif');
    log('State notifications on');
    await withTimeout(audioChar.startNotifications(), 12000, 'Audio notif');
    log('Audio notifications on');

    audioChar.addEventListener('characteristicvaluechanged', handleAudioSubPacket);
    battChar.addEventListener('characteristicvaluechanged',  handleBattery);
    stateChar.addEventListener('characteristicvaluechanged', handleState);

    try { handleBattery({ target: { value: await withTimeout(battChar.readValue(), 3000, 'Read batt') } }); } catch {}
    try { handleState({ target: { value: await withTimeout(stateChar.readValue(), 3000, 'Read state') } }); } catch {}

    clearReconnect();
    startNoAudioMonitor();
    connState.textContent = `Connected: ${device.name || 'TossTalk'}`;
    log('BLE connected. Device sends audio after ~2.5 s warmup.');
  } catch (err) {
    connState.textContent = 'Connect failed';
    log(`Connect failed: ${formatError(err)}`);
    try { if (server?.device?.gatt?.connected) server.device.gatt.disconnect(); } catch {}
    try { if (bleDevice?.gatt?.connected) bleDevice.gatt.disconnect(); } catch {}
    throw err;
  } finally {
    isConnecting = false;
  }
}

function clearReconnect() { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } }
function scheduleReconnect() {
  if (!bleDevice || reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try { connState.textContent = 'Reconnecting...'; await connectBle(); }
    catch { scheduleReconnect(); }
  }, 1500);
}

// ── Flashing (unchanged from v1) ─────────────────────────────────────────
function setFlashStatus(t) { flashStatus.textContent = t; log(`FLASH: ${t}`); }
function parseAddr(v) { const s = v.trim().toLowerCase(); return s.startsWith('0x') ? parseInt(s.slice(2),16) : parseInt(s,10); }
function pad4(u8) { const r = u8.length % 4; if (!r) return u8; const o = new Uint8Array(u8.length + 4 - r); o.set(u8); return o; }

async function loadEsptool() {
  if (esptoolMod) return esptoolMod;
  for (const url of ESPTOOL_URLS) { try { esptoolMod = await import(url); return esptoolMod; } catch {} }
  throw new Error('Unable to load esptool-js');
}

async function loadFirmware() {
  const file = firmwareFileIn.files?.[0];
  const url  = firmwareUrlIn.value.trim() || DEFAULT_FW_URL;
  if (file) return { name: file.name, data: new Uint8Array(await file.arrayBuffer()) };
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Fetch failed (${r.status})`);
  return { name: url, data: new Uint8Array(await r.arrayBuffer()) };
}

async function startFlashFlow() {
  if (!('serial' in navigator)) { alert('Web Serial unavailable.'); return; }
  flashBtn.disabled = true;
  flashProgress.value = 0;
  let transport = null;
  try {
    setFlashStatus('Loading esptool-js...');
    const { ESPLoader, Transport } = await loadEsptool();
    setFlashStatus('Reading firmware...');
    const fw = await loadFirmware();
    const addr = parseAddr(flashAddressIn.value);
    if (!Number.isFinite(addr) || addr < 0) throw new Error('Invalid flash address');

    setFlashStatus('Select serial port...');
    const port = await navigator.serial.requestPort({});
    const term = { clean(){}, writeLine(d){ log(String(d)); }, write(d){ log(String(d)); } };
    transport = new Transport(port, false);
    const loader = new ESPLoader({ transport, baudrate: 115200, terminal: term, debugLogging: false });

    setFlashStatus('Connecting to chip...');
    const chip = await loader.main('default_reset');
    log(`Chip: ${chip}`);

    let image = pad4(fw.data);
    if (eraseAllIn.checked && loader.IS_STUB) { setFlashStatus('Erasing...'); await loader.eraseFlash(); }

    const bs = loader.FLASH_WRITE_SIZE || 0x4000;
    const blocks = await loader.flashBegin(image.length, addr);
    let off = 0;
    for (let s = 0; s < blocks; s++) {
      const end = Math.min(off + bs, image.length);
      const blk = image.slice(off, end);
      const to = Math.max(3000, loader.timeoutPerMb(loader.ERASE_WRITE_TIMEOUT_PER_MB, Math.max(1, blk.length)));
      await loader.flashBlock(blk, s, to);
      off = end;
      const pct = Math.round((off / image.length) * 100);
      flashProgress.value = pct;
      flashStatus.textContent = `Flashing ${pct}%`;
    }
    await loader.flashFinish(false);
    setFlashStatus('Rebooting...');
    await loader.after('hard_reset');
    setFlashStatus(`Done: ${fw.name}`);
  } catch (err) {
    setFlashStatus(`Failed: ${formatError(err)}`);
    throw err;
  } finally {
    flashBtn.disabled = false;
    if (transport) { try { await transport.disconnect(); } catch {} }
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────
connectBtn.addEventListener('click', () => connectBle().catch(e => log(`Connect: ${e.message}`)));
flashBtn.addEventListener('click', () => startFlashFlow().catch(e => log(`Flash: ${e.message}`)));
updateStatsUi();
if (!firmwareUrlIn.value.trim()) firmwareUrlIn.value = DEFAULT_FW_URL;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); });
}
