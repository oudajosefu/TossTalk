// TossTalk - debug console (wired to shared core.js)
import {
  connectBle,
  flashFirmware,
  on,
  stats,
  DEFAULT_FW_URL,
  jitterQueue,
} from "../core.js";

// ── DOM elements ─────────────────────────────────────────────────────────
const connectBtn = document.getElementById("connectBtn");
const flashBtn = document.getElementById("flashBtn");
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
