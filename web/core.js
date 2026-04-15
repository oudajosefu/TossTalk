// TossTalk - shared BLE + audio + flashing core
// Both the main UI and the debug console import this module.

// ── BLE UUIDs ────────────────────────────────────────────────────────────
const SERVICE_UUID = "9f8d0001-6b7b-4f26-b10f-3aa861aa0001";
const AUDIO_CHAR_UUID = "9f8d0002-6b7b-4f26-b10f-3aa861aa0001";
const BATT_CHAR_UUID = "9f8d0003-6b7b-4f26-b10f-3aa861aa0001";
const STATE_CHAR_UUID = "9f8d0004-6b7b-4f26-b10f-3aa861aa0001";
const CONTROL_CHAR_UUID = "9f8d0005-6b7b-4f26-b10f-3aa861aa0001";

// ── Audio constants ──────────────────────────────────────────────────────
const SAMPLE_RATE = 8000;
const SAMPLE_COUNT = 160;
const FRAME_MS = 20;
const TARGET_BUFFER = 4;
const MAX_BUFFER = 24;
const MAX_CONCEAL = 2;

// ── ADPCM tables ─────────────────────────────────────────────────────────
const INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
const STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
  253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
  3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
  11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
];

// ── esptool URLs ─────────────────────────────────────────────────────────
const ESPTOOL_URLS = [
  "https://esm.sh/esptool-js@0.5.6?bundle",
  "https://esm.sh/esptool-js@0.5.6",
  "https://cdn.skypack.dev/esptool-js@0.5.6",
];
const DEFAULT_FW_URL = new URL(
  "./firmware/tosstalk-merged.bin",
  import.meta.url,
).href;

// ── Shared state ─────────────────────────────────────────────────────────
let audioCtx;
let scheduleAt = 0;
let bleDevice = null;
let reconnectTimer = null;
let isConnecting = false;
let jitterTimer = null;
let playoutStarted = false;
let lastGoodFrame = null;
let lastAudioAt = 0;
let noAudioTimer = null;
let esptoolMod = null;
let lastGateName = "";
let playoutErrStreak = 0;
let malformedPktCount = 0;
const jitterQueue = [];

// Track characteristic references so we can remove listeners on disconnect
let activeAudioChar = null;
let activeBattChar = null;
let activeStateChar = null;
let activeControlChar = null;
let activeDisconnectDevice = null;
let activeDisconnectHandler = null;

// Sub-packet reassembly
let assemblySeq = null,
  assemblyPkts = 0,
  assemblyAdpcm = null;
let assemblyPred = 0,
  assemblyIdx = 0,
  assemblyMuted = false;
let lastCompleteSeq = null;

// Stats (readable by UIs)
export const stats = {
  frames: 0,
  drops: 0,
  mutedFrames: 0,
  concealedFrames: 0,
  subPkts: 0,
};

// ── Event bus ────────────────────────────────────────────────────────────
// UIs register callbacks; core fires them at the right time.
const listeners = {
  log: [], // (message: string) — diagnostic log
  stats: [], // () — stats changed
  connection: [], // (state: string) — connState text
  battery: [], // (pct: number, charging: boolean)
  gate: [], // (stateName: string)
  audio: [], // (pcmInt16: Int16Array) — every decoded frame for volume metering
  flashProgress: [], // (pct: number)
  flashStatus: [], // (message: string)
};

export function on(event, fn) {
  if (listeners[event]) listeners[event].push(fn);
}

function emit(event, ...args) {
  for (const fn of listeners[event] || []) {
    try {
      fn(...args);
    } catch {}
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────
function withTimeout(promise, ms, label) {
  let tid;
  const to = new Promise((_, rej) => {
    tid = setTimeout(() => rej(new Error(`${label} timed out (${ms}ms)`)), ms);
  });
  return Promise.race([promise, to]).finally(() => clearTimeout(tid));
}

function formatError(e) {
  if (!e) return "Unknown";
  if (typeof e === "string") return e;
  if (e?.message) return String(e.message);
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

// ── No-audio watchdog ────────────────────────────────────────────────────
function clearNoAudioMonitor() {
  if (noAudioTimer) {
    clearInterval(noAudioTimer);
    noAudioTimer = null;
  }
}
function startNoAudioMonitor() {
  clearNoAudioMonitor();
  lastAudioAt = Date.now();
  noAudioTimer = setInterval(() => {
    const silence = Date.now() - lastAudioAt;
    if (silence > 4000) {
      emit(
        "log",
        `No audio for ${Math.round(silence / 1000)}s (${stats.subPkts} sub-pkts). Check device.`,
      );
      emit("connection", "No audio \u2014 reconnect");
    }
  }, 2000);
}

// ── Audio engine ─────────────────────────────────────────────────────────
function ensureAudio() {
  if (!audioCtx) audioCtx = new AudioContext({ sampleRate: 48000 });
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
}

function resetAudioPipeline() {
  // Stop the playout timer — a stale timer with an old scheduleAt
  // will either underrun continuously or block real audio.
  if (jitterTimer) {
    clearInterval(jitterTimer);
    jitterTimer = null;
  }
  jitterQueue.length = 0;
  playoutStarted = false;
  lastGoodFrame = null;
  assemblySeq = null;
  assemblyPkts = 0;
  assemblyAdpcm = null;
  lastCompleteSeq = null;
  // Close AudioContext to release all accumulated AudioNodes.
  // A fresh context on reconnect prevents the slow node leak that
  // eventually exhausts Chrome's per-context limits.
  if (audioCtx) {
    try {
      audioCtx.close();
    } catch {}
    audioCtx = null;
  }
  scheduleAt = 0;
  playoutErrStreak = 0;
  malformedPktCount = 0;
  // Reset stats for clean session
  stats.frames = 0;
  stats.drops = 0;
  stats.mutedFrames = 0;
  stats.concealedFrames = 0;
  stats.subPkts = 0;
  emit("stats");
}

function makeConceal(n) {
  return new Int16Array(n);
}

function enqueue(frame) {
  if (jitterQueue.length >= MAX_BUFFER) {
    jitterQueue.shift();
    stats.drops++;
  }
  jitterQueue.push(frame);
  emit("stats");
}

function ensurePlayoutLoop() {
  if (jitterTimer) return;
  jitterTimer = setInterval(() => {
    try {
      ensureAudio();
      if (!playoutStarted) {
        if (jitterQueue.length < TARGET_BUFFER) return;
        playoutStarted = true;
        scheduleAt = audioCtx.currentTime;
      }

      const now = audioCtx.currentTime;
      if (scheduleAt < now) scheduleAt = now;

      // If scheduleAt drifts far ahead, user hears heavy delay.
      // Clamp latency and shed backlog to recover quickly.
      if (scheduleAt > now + 0.6) {
        emit("log", "Playout backlog exceeded 600ms; trimming latency");
        scheduleAt = now + 0.12;
        while (jitterQueue.length > TARGET_BUFFER + 2) {
          jitterQueue.shift();
          stats.drops++;
        }
      }

      // Gradual drift correction: shed at most 1 excess frame per tick.
      if (jitterQueue.length > TARGET_BUFFER + 4) {
        jitterQueue.shift();
        stats.drops++;
      }

      // Collect frames that fit in the look-ahead window and merge them
      // into ONE AudioBuffer + ONE BufferSourceNode.  The old code
      // created a separate node per 20 ms frame (~50 nodes/sec).  After
      // 3-5 minutes Chrome's per-context node count hit ~10 000 and
      // createBufferSource() started throwing, silently killing audio.
      const LEAD_S = 0.12;
      const FRAME_DUR = SAMPLE_COUNT / SAMPLE_RATE; // 0.02 s
      const batch = [];
      let batchEnd = scheduleAt;
      while (jitterQueue.length > 0 && batchEnd < now + LEAD_S) {
        batch.push(jitterQueue.shift());
        batchEnd += FRAME_DUR;
      }

      if (batch.length > 0) {
        const totalSamples = batch.length * SAMPLE_COUNT;
        const merged = new Float32Array(totalSamples);
        let off = 0;
        for (const frame of batch) {
          for (let i = 0; i < frame.length; i++)
            merged[off++] = frame[i] / 32768;
        }
        const buf = audioCtx.createBuffer(1, totalSamples, SAMPLE_RATE);
        buf.copyToChannel(merged, 0);
        const src = audioCtx.createBufferSource();
        src.buffer = buf;
        src.connect(audioCtx.destination);
        src.onended = () => {
          try {
            src.disconnect();
          } catch {}
        };
        src.start(scheduleAt);
        scheduleAt += buf.duration;
        lastGoodFrame = batch[batch.length - 1];
        for (const frame of batch) emit("audio", frame);
      }

      playoutErrStreak = 0;

      emit("stats");
    } catch (e) {
      emit("log", `Playout error: ${formatError(e)}`);
      playoutErrStreak++;
      if (playoutErrStreak >= 3) {
        emit("connection", "Playback fault — reconnect");
      }
    }
  }, 50);
}

// ── IMA ADPCM decoder ───────────────────────────────────────────────────
function decodeAdpcm(data, count, predictor, index) {
  const out = new Int16Array(count);
  let pred = predictor,
    idx = Math.min(88, Math.max(0, index)),
    o = 0;
  for (let i = 0; i < data.length && o < count; i++) {
    const b = data[i];
    for (const nib of [b & 0x0f, (b >> 4) & 0x0f]) {
      let step = STEP_TABLE[idx],
        diff = step >> 3;
      if (nib & 1) diff += step >> 2;
      if (nib & 2) diff += step >> 1;
      if (nib & 4) diff += step;
      pred += nib & 8 ? -diff : diff;
      pred = Math.max(-32768, Math.min(32767, pred));
      idx += INDEX_TABLE[nib];
      idx = Math.max(0, Math.min(88, idx));
      out[o++] = pred;
      if (o >= count) break;
    }
  }
  return out;
}

// ── Sub-packet reassembly ────────────────────────────────────────────────
function resetAssembly() {
  assemblySeq = null;
  assemblyPkts = 0;
  assemblyAdpcm = new Uint8Array(80);
  assemblyPred = 0;
  assemblyIdx = 0;
  assemblyMuted = false;
}

function finalizeFrame() {
  if (assemblyMuted) {
    enqueue(new Int16Array(SAMPLE_COUNT));
    stats.mutedFrames++;
  } else {
    const pcm = decodeAdpcm(
      assemblyAdpcm,
      SAMPLE_COUNT,
      assemblyPred,
      assemblyIdx,
    );
    lastGoodFrame = pcm;
    enqueue(pcm);
  }
  // Correct gate display if in-band muted flag disagrees with last BLE state
  if (!assemblyMuted && lastGateName && lastGateName !== "UnmutedLive") {
    lastGateName = "UnmutedLive";
    emit("gate", "UnmutedLive");
  }
  stats.frames++;
  if (lastCompleteSeq !== null) {
    let gap = ((assemblySeq - lastCompleteSeq + 256) % 256) - 1;
    if (gap > 0 && gap < 60) {
      const conceal = Math.min(gap, MAX_CONCEAL);
      for (let i = 0; i < conceal; i++) {
        enqueue(makeConceal(SAMPLE_COUNT));
        stats.concealedFrames++;
      }
    }
  }
  lastCompleteSeq = assemblySeq;
  ensurePlayoutLoop();
}

function handleAudioSubPacket(event) {
  try {
    const dv = event.target.value;
    if (!dv || dv.byteLength < 2) return;
    lastAudioAt = Date.now();
    stats.subPkts++;

    const seq = dv.getUint8(0),
      byte1 = dv.getUint8(1);
    const pktIdx = byte1 & 0x0f,
      muted = !!(byte1 & 0x80);

    if (stats.subPkts <= 5)
      emit(
        "log",
        `Pkt #${stats.subPkts}: seq=${seq} idx=${pktIdx} len=${dv.byteLength} muted=${muted}`,
      );

    // Single-packet mode
    if (pktIdx === 0 && dv.byteLength >= 85) {
      if (assemblySeq !== null && assemblyPkts !== 0) finalizeFrame();
      resetAssembly();
      const pred = dv.getInt16(2, true),
        idx = dv.getUint8(4);
      const adpcm = new Uint8Array(dv.buffer, dv.byteOffset + 5, 80);

      if (lastCompleteSeq !== null) {
        let gap = ((seq - lastCompleteSeq + 256) % 256) - 1;
        if (gap > 0 && gap < 60) {
          const conceal = Math.min(gap, MAX_CONCEAL);
          for (let i = 0; i < conceal; i++) {
            enqueue(makeConceal(SAMPLE_COUNT));
            stats.concealedFrames++;
          }
        }
      }
      lastCompleteSeq = seq;

      if (muted) {
        enqueue(new Int16Array(SAMPLE_COUNT));
        stats.mutedFrames++;
      } else {
        const pcm = decodeAdpcm(adpcm, SAMPLE_COUNT, pred, idx);
        lastGoodFrame = pcm;
        enqueue(pcm);
      }
      // Correct gate display if in-band muted flag disagrees with last BLE state
      if (!muted && lastGateName && lastGateName !== "UnmutedLive") {
        lastGateName = "UnmutedLive";
        emit("gate", "UnmutedLive");
      }
      stats.frames++;
      if (stats.frames <= 3)
        emit(
          "log",
          `Frame #${stats.frames} (single-pkt): seq=${seq} pred=${pred} idx=${idx} muted=${muted}`,
        );
      ensurePlayoutLoop();
      emit("stats");
      return;
    }

    // Sub-packet mode
    if (seq !== assemblySeq) {
      if (assemblySeq !== null && assemblyPkts !== 0) finalizeFrame();
      resetAssembly();
      assemblySeq = seq;
    }
    assemblyMuted = assemblyMuted || muted;

    if (pktIdx === 0 && dv.byteLength >= 20) {
      assemblyPred = dv.getInt16(2, true);
      assemblyIdx = dv.getUint8(4);
      assemblyAdpcm.set(new Uint8Array(dv.buffer, dv.byteOffset + 5, 15), 0);
      assemblyPkts |= 1;
    } else if (pktIdx >= 1 && pktIdx <= 3 && dv.byteLength >= 20) {
      assemblyAdpcm.set(
        new Uint8Array(dv.buffer, dv.byteOffset + 2, 18),
        15 + (pktIdx - 1) * 18,
      );
      assemblyPkts |= 1 << pktIdx;
    } else if (pktIdx === 4 && dv.byteLength >= 13) {
      assemblyAdpcm.set(new Uint8Array(dv.buffer, dv.byteOffset + 2, 11), 69);
      assemblyPkts |= 1 << 4;
    }

    if (stats.frames < 5 && assemblyPkts === 0x1f)
      emit(
        "log",
        `Frame #${stats.frames + 1} complete: seq=${seq}, muted=${muted}`,
      );

    if (assemblyPkts === 0x1f) {
      finalizeFrame();
      resetAssembly();
    }
    emit("stats");
  } catch (e) {
    malformedPktCount++;
    emit(
      "log",
      `Audio packet parse error #${malformedPktCount}: ${formatError(e)}`,
    );
    if (malformedPktCount >= 5) {
      emit("connection", "Audio stream error — reconnect");
    }
  }
}

// ── Battery / State handlers ─────────────────────────────────────────────
let smoothBatt = -1; // web-side EMA for extra jitter suppression
function handleBattery(event) {
  const dv = event.target.value;
  if (!dv || dv.byteLength < 2) return;
  const raw = dv.getUint8(0),
    charging = dv.getUint8(1) === 1;
  if (smoothBatt < 0) smoothBatt = raw;
  else smoothBatt = raw * 0.3 + smoothBatt * 0.7;
  const pct = Math.round(smoothBatt);
  emit("battery", pct, charging);
}

const GATE_NAMES = [
  "UnmutedLive",
  "AirborneSuppressed",
  "ImpactLockout",
  "Reacquire",
];

function handleState(event) {
  const dv = event.target.value;
  if (!dv || dv.byteLength < 1) return;
  const name = GATE_NAMES[dv.getUint8(0)] || `Unknown(${dv.getUint8(0)})`;
  lastGateName = name;
  emit("gate", name);
}

// ── BLE connect ──────────────────────────────────────────────────────────
export async function connectBle() {
  if (isConnecting) {
    emit("log", "Connect already in progress");
    return;
  }
  let server = null;
  isConnecting = true;
  try {
    if (!("bluetooth" in navigator)) {
      emit("connection", "Unavailable");
      alert(
        "Web Bluetooth unavailable. Use Chrome or Edge desktop over HTTPS.",
      );
      return;
    }

    if (bleDevice?.gatt?.connected) {
      emit("connection", "Connected");
      emit("log", "Already connected");
      return;
    }

    let device = bleDevice;
    if (!device) {
      emit("connection", "Selecting device...");
      device = await withTimeout(
        navigator.bluetooth.requestDevice({
          filters: [{ services: [SERVICE_UUID] }],
          optionalServices: [SERVICE_UUID],
        }),
        30000,
        "Device picker",
      );
      bleDevice = device;
    } else {
      emit("log", "Reusing remembered device");
    }

    // Ensure at most one disconnect listener is bound.
    cleanupDisconnectListener();
    activeDisconnectDevice = device;
    activeDisconnectHandler = () => {
      emit("connection", "Disconnected");
      emit("log", "BLE disconnected");
      lastGateName = "";
      smoothBatt = -1;
      cleanupCharListeners();
      resetAudioPipeline();
      clearNoAudioMonitor();
    };
    device.addEventListener("gattserverdisconnected", activeDisconnectHandler);

    let service = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        emit("connection", attempt === 1 ? "Connecting..." : "Reconnecting...");
        if (!device.gatt.connected) {
          server = await withTimeout(
            device.gatt.connect(),
            15000,
            "GATT connect",
          );
        } else {
          server = device.gatt;
        }
        resetAudioPipeline();

        emit("connection", "Waiting for device to settle...");
        await new Promise((r) => setTimeout(r, 3000));

        for (let st = 1; st <= 3; st++) {
          emit("connection", `Service discovery (${st}/3)...`);
          try {
            service = await withTimeout(
              server.getPrimaryService(SERVICE_UUID),
              10000,
              "Service",
            );
            break;
          } catch (e) {
            emit("log", `Service try ${st}/3 failed: ${formatError(e)}`);
            if (!device.gatt.connected) {
              emit(
                "log",
                "⚠️ Connection lost. Try power-cycling the device and reconnecting.",
              );
              await new Promise((r) => setTimeout(r, 1000));
              server = await withTimeout(
                device.gatt.connect(),
                12000,
                "GATT reconnect",
              );
              await new Promise((r) => setTimeout(r, 3000));
            }
            if (st === 3) throw e;
          }
        }
        break;
      } catch (e) {
        emit("log", `Attempt ${attempt} failed: ${formatError(e)}`);
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        throw e;
      }
    }
    if (!service) throw new Error("Service resolution failed");

    emit("connection", "Getting characteristics...");
    const [audioChar, battChar, stateChar] = await withTimeout(
      Promise.all([
        service.getCharacteristic(AUDIO_CHAR_UUID),
        service.getCharacteristic(BATT_CHAR_UUID),
        service.getCharacteristic(STATE_CHAR_UUID),
      ]),
      8000,
      "Characteristics",
    );

    // Control characteristic (write-only) — optional, best-effort
    let controlChar = null;
    try {
      controlChar = await withTimeout(
        service.getCharacteristic(CONTROL_CHAR_UUID),
        4000,
        "Control char",
      );
      emit("log", "Control characteristic available");
    } catch {
      emit("log", "Control characteristic not found (older firmware?)");
    }

    emit("connection", "Starting notifications...");
    await withTimeout(battChar.startNotifications(), 7000, "Battery notif");
    emit("log", "Battery notifications on");
    await withTimeout(stateChar.startNotifications(), 7000, "State notif");
    emit("log", "State notifications on");
    await withTimeout(audioChar.startNotifications(), 12000, "Audio notif");
    emit("log", "Audio notifications on");

    // Store refs so we can remove listeners on disconnect
    activeAudioChar = audioChar;
    activeBattChar = battChar;
    activeStateChar = stateChar;
    activeControlChar = controlChar;
    audioChar.addEventListener(
      "characteristicvaluechanged",
      handleAudioSubPacket,
    );
    battChar.addEventListener("characteristicvaluechanged", handleBattery);
    stateChar.addEventListener("characteristicvaluechanged", handleState);

    try {
      handleBattery({
        target: {
          value: await withTimeout(battChar.readValue(), 3000, "Read batt"),
        },
      });
    } catch {}
    try {
      handleState({
        target: {
          value: await withTimeout(stateChar.readValue(), 3000, "Read state"),
        },
      });
    } catch {}

    clearReconnect();
    startNoAudioMonitor();
    emit("connection", `Connected`);
    emit("log", "BLE connected. Device sends audio after ~2.5 s warmup.");
  } catch (err) {
    emit("connection", "Connect failed");
    emit("log", `Connect failed: ${formatError(err)}`);
    try {
      if (server?.device?.gatt?.connected) server.device.gatt.disconnect();
    } catch {}
    try {
      if (bleDevice?.gatt?.connected) bleDevice.gatt.disconnect();
    } catch {}
    throw err;
  } finally {
    isConnecting = false;
  }
}

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function cleanupDisconnectListener() {
  if (activeDisconnectDevice && activeDisconnectHandler) {
    try {
      activeDisconnectDevice.removeEventListener(
        "gattserverdisconnected",
        activeDisconnectHandler,
      );
    } catch {}
  }
  activeDisconnectDevice = null;
  activeDisconnectHandler = null;
}

// Remove event listeners from characteristics to prevent duplicate handlers
function cleanupCharListeners() {
  if (activeAudioChar) {
    try {
      activeAudioChar.removeEventListener(
        "characteristicvaluechanged",
        handleAudioSubPacket,
      );
    } catch {}
    activeAudioChar = null;
  }
  if (activeBattChar) {
    try {
      activeBattChar.removeEventListener(
        "characteristicvaluechanged",
        handleBattery,
      );
    } catch {}
    activeBattChar = null;
  }
  if (activeStateChar) {
    try {
      activeStateChar.removeEventListener(
        "characteristicvaluechanged",
        handleState,
      );
    } catch {}
    activeStateChar = null;
  }
  activeControlChar = null;
}

// Full cleanup of BLE state — called before connecting to a new device
function cleanupBle() {
  clearReconnect();
  cleanupDisconnectListener();
  cleanupCharListeners();
  if (bleDevice) {
    try {
      bleDevice.gatt.disconnect();
    } catch {}
    bleDevice = null;
  }
  resetAudioPipeline();
  clearNoAudioMonitor();
}

// ── Flashing ─────────────────────────────────────────────────────────────
function pad4(u8) {
  const r = u8.length % 4;
  if (!r) return u8;
  const o = new Uint8Array(u8.length + 4 - r);
  o.set(u8);
  return o;
}

async function loadEsptool() {
  if (esptoolMod) return esptoolMod;
  for (const url of ESPTOOL_URLS) {
    try {
      esptoolMod = await import(url);
      return esptoolMod;
    } catch {}
  }
  throw new Error("Unable to load esptool-js");
}

export async function flashFirmware({
  firmwareUrl,
  firmwareFile,
  flashAddress = 0,
  eraseAll = false,
  logFn,
}) {
  const log = logFn || ((m) => emit("log", m));
  if (!("serial" in navigator)) {
    alert("Web Serial unavailable.");
    return;
  }
  let transport = null;
  try {
    emit("flashStatus", "Loading esptool-js...");
    const { ESPLoader, Transport } = await loadEsptool();

    emit("flashStatus", "Reading firmware...");
    let fw;
    if (firmwareFile) {
      fw = {
        name: firmwareFile.name,
        data: new Uint8Array(await firmwareFile.arrayBuffer()),
      };
    } else {
      const url = firmwareUrl || DEFAULT_FW_URL;
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) throw new Error(`Fetch failed (${r.status})`);
      fw = { name: url, data: new Uint8Array(await r.arrayBuffer()) };
    }

    emit("flashStatus", "Select serial port...");
    const port = await navigator.serial.requestPort({});
    const term = {
      clean() {},
      writeLine(d) {
        log(String(d));
      },
      write(d) {
        log(String(d));
      },
    };
    transport = new Transport(port, false);
    const loader = new ESPLoader({
      transport,
      baudrate: 115200,
      terminal: term,
      debugLogging: false,
    });

    emit("flashStatus", "Connecting to chip...");
    const chip = await loader.main("default_reset");
    log(`Chip: ${chip}`);

    let image = pad4(fw.data);
    if (eraseAll && loader.IS_STUB) {
      emit("flashStatus", "Erasing...");
      await loader.eraseFlash();
    }

    const bs = loader.FLASH_WRITE_SIZE || 0x4000;
    const blocks = await loader.flashBegin(image.length, flashAddress);
    let off = 0;
    for (let s = 0; s < blocks; s++) {
      const end = Math.min(off + bs, image.length);
      const blk = image.slice(off, end);
      const to = Math.max(
        3000,
        loader.timeoutPerMb(
          loader.ERASE_WRITE_TIMEOUT_PER_MB,
          Math.max(1, blk.length),
        ),
      );
      await loader.flashBlock(blk, s, to);
      off = end;
      const pct = Math.round((off / image.length) * 100);
      emit("flashProgress", pct);
      emit("flashStatus", `Flashing ${pct}%`);
    }
    await loader.flashFinish(false);
    emit("flashStatus", "Rebooting...");
    await loader.after("hard_reset");
    emit("flashStatus", `Done ✓`);
  } catch (err) {
    emit("flashStatus", `Failed: ${formatError(err)}`);
    throw err;
  } finally {
    if (transport) {
      try {
        await transport.disconnect();
      } catch {}
    }
  }
}

export { DEFAULT_FW_URL, jitterQueue, SAMPLE_COUNT };

// ── Runtime audio config (write to firmware via Control characteristic) ───
export async function sendAudioConfig(gainQ12, noiseGate, softLimit) {
  if (!activeControlChar) {
    emit("log", "Control char not available");
    return;
  }
  const buf = new ArrayBuffer(9);
  const view = new DataView(buf);
  view.setUint8(0, 0x01); // CMD_SET_AUDIO_PARAMS
  view.setInt32(1, gainQ12, true); // gain_q12 LE
  view.setInt16(5, noiseGate, true); // noise_gate LE
  view.setInt16(7, softLimit, true); // soft_limit LE
  try {
    await activeControlChar.writeValueWithoutResponse(buf);
    emit(
      "log",
      `Audio config sent: gain=${(gainQ12 / 4096).toFixed(1)}× gate=${noiseGate} limit=${softLimit}`,
    );
  } catch (e) {
    emit("log", `Audio config write failed: ${e.message}`);
  }
}

// ── Sleep command (deep-sleep / power-off the device) ────────────────────
export async function sendSleep() {
  if (!activeControlChar) {
    emit("log", "Control char not available");
    return;
  }
  const buf = new ArrayBuffer(1);
  new DataView(buf).setUint8(0, 0x02); // CMD_SLEEP
  try {
    await activeControlChar.writeValueWithoutResponse(buf);
    emit("log", "Sleep command sent — device will power off");
  } catch (e) {
    emit("log", `Sleep command failed: ${e.message}`);
  }
  // Clean up so we don't try to auto-reconnect and wake the device
  cleanupBle();
}
