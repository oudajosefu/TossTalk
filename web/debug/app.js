// TossTalk - debug console (wired to shared core.js)
import {
  connectBle,
  flashFirmware,
  on,
  stats,
  DEFAULT_FW_URL,
  jitterQueue,
  sendAudioConfig,
  sendSleep,
} from "../core.js";

// ── DOM elements ─────────────────────────────────────────────────────────
const connectBtn = document.getElementById("connectBtn");
const flashBtn = document.getElementById("flashBtn");
const sleepBtn = document.getElementById("sleepBtn");
const connState = document.getElementById("connState");
const gateStateEl = document.getElementById("gateState");
const batteryEl = document.getElementById("battery");
const firmwareUrlIn = document.getElementById("firmwareUrl");
const firmwareFileIn = document.getElementById("firmwareFile");
const flashAddressIn = document.getElementById("flashAddress");
const eraseAllIn = document.getElementById("eraseAll");
const flashProgress = document.getElementById("flashProgress");
const flashStatus = document.getElementById("flashStatus");
const frameCountEl = document.getElementById("frameCount");
const dropCountEl = document.getElementById("dropCount");
const mutedCountEl = document.getElementById("mutedCount");
const concealedCountEl = document.getElementById("concealedCount");
const bufferDepthEl = document.getElementById("bufferDepth");
const logs = document.getElementById("logs");

function updateStatsUi() {
  frameCountEl.textContent = String(stats.frames);
  dropCountEl.textContent = String(stats.drops);
  mutedCountEl.textContent = String(stats.mutedFrames);
  concealedCountEl.textContent = String(stats.concealedFrames);
  bufferDepthEl.textContent = String(jitterQueue.length);
}

function log(msg) {
  const t = new Date().toLocaleTimeString();
  logs.textContent = `[${t}] ${msg}\n` + logs.textContent;
}

// ── Core events → UI ─────────────────────────────────────────────────────
on("log", log);
on("stats", updateStatsUi);
on("connection", (state) => {
  connState.textContent = state;
  sleepBtn.disabled = state !== "Connected";
});
on("battery", (pct, chrg) => {
  batteryEl.textContent = `${pct}%${chrg ? " (charging)" : ""}`;
});
on("gate", (name) => {
  gateStateEl.textContent = name;
});
on("flashProgress", (pct) => {
  flashProgress.value = pct;
});
on("flashStatus", (msg) => {
  flashStatus.textContent = msg;
  log(`FLASH: ${msg}`);
});

// ── Button handlers ──────────────────────────────────────────────────────
connectBtn.addEventListener("click", () => {
  connectBle().catch((e) => log(`Connect: ${e.message}`));
});

sleepBtn.addEventListener("click", () => {
  if (
    !confirm(
      "Power off the microphone?\nPress the BOOT button on the device to wake it.",
    )
  )
    return;
  sendSleep().catch((e) => log(`Sleep: ${e.message}`));
});

flashBtn.addEventListener("click", async () => {
  flashBtn.disabled = true;
  flashProgress.value = 0;
  try {
    const file = firmwareFileIn.files?.[0];
    const url = firmwareUrlIn.value.trim() || DEFAULT_FW_URL;
    const addr = parseAddr(flashAddressIn.value);
    await flashFirmware({
      firmwareUrl: url,
      firmwareFile: file || null,
      flashAddress: addr,
      eraseAll: eraseAllIn.checked,
      logFn: log,
    });
  } catch (e) {
    log(`Flash: ${e.message}`);
  }
  flashBtn.disabled = false;
});

function parseAddr(v) {
  const s = v.trim().toLowerCase();
  return s.startsWith("0x") ? parseInt(s.slice(2), 16) : parseInt(s, 10);
}

updateStatsUi();
firmwareUrlIn.value = DEFAULT_FW_URL;

// ── Mic Tuning UI ─────────────────────────────────────────────────────────
const gainSlider = document.getElementById("gainSlider");
const gateSlider = document.getElementById("gateSlider");
const limitSlider = document.getElementById("limitSlider");
const gainVal = document.getElementById("gainVal");
const gateVal = document.getElementById("gateVal");
const limitVal = document.getElementById("limitVal");
const applyTuningBtn = document.getElementById("applyTuningBtn");
const autoSendIn = document.getElementById("autoSend");

// Gain slider is 0–200 mapping to 0.0×–20.0× (×0.1× per step)
function gainSliderToQ12() {
  return Math.round(parseFloat(gainSlider.value) * 0.1 * 4096);
}

function updateGainLabel() {
  gainVal.textContent = (parseFloat(gainSlider.value) * 0.1).toFixed(1);
}

function updateGateLabel() {
  gateVal.textContent = gateSlider.value;
}

function updateLimitLabel() {
  limitVal.textContent = limitSlider.value;
}

function applyTuning() {
  const g = gainSliderToQ12();
  const ng = parseInt(gateSlider.value, 10);
  const sl = parseInt(limitSlider.value, 10);
  sendAudioConfig(g, ng, sl).catch((e) => log(`Tuning: ${e.message}`));
}

gainSlider.addEventListener("input", () => {
  updateGainLabel();
  if (autoSendIn.checked) applyTuning();
});
gateSlider.addEventListener("input", () => {
  updateGateLabel();
  if (autoSendIn.checked) applyTuning();
});
limitSlider.addEventListener("input", () => {
  updateLimitLabel();
  if (autoSendIn.checked) applyTuning();
});

applyTuningBtn.addEventListener("click", applyTuning);
