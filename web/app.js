// TossTalk – main UI
import { connectBle, flashFirmware, on, stats, DEFAULT_FW_URL } from './core.js';

// ── DOM refs ─────────────────────────────────────────────────────────────
const connectBtn   = document.getElementById('connectBtn');
const connStateEl  = document.getElementById('connState');
const statusDot    = document.getElementById('statusDot');
const volumeCard   = document.getElementById('volumeCard');
const volBar       = document.getElementById('volBar');
const volIcon      = document.getElementById('volIcon');
const volDesc      = document.getElementById('volDesc');
const gateStateEl  = document.getElementById('gateState');
const batteryEl    = document.getElementById('battery');
const flashBtn     = document.getElementById('flashBtn');
const flashProgress = document.getElementById('flashProgress');
const flashStatus  = document.getElementById('flashStatus');

// ── Volume meter state ───────────────────────────────────────────────────
const CIRC = 2 * Math.PI * 65;            // circumference of the SVG circle
let smoothLevel = 0;                       // smoothed 0-1 level
let connected = false;
let lastAudioEventMs = 0;                  // for volume decay

// ── Friendly gate names ──────────────────────────────────────────────────
const FRIENDLY_GATE = {
  UnmutedLive:        '🟢 Live',
  AirborneSuppressed: '✈️ In the air',
  ImpactLockout:      '🛑 Caught!',
  Reacquire:          '⏳ Settling…',
};

// ── Wire core events ─────────────────────────────────────────────────────
on('connection', (state) => {
  connStateEl.textContent = state;
  statusDot.className = 'status-dot';
  if (state === 'Connected') {
    connected = true;
    connectBtn.textContent = '✓ Connected';
    connectBtn.classList.add('connected');
    statusDot.classList.add('live');
    volumeCard.style.display = '';
  } else if (state === 'Disconnected' || state === 'Connect failed') {
    connected = false;
    connectBtn.textContent = 'Connect Microphone';
    connectBtn.classList.remove('connected');
    volumeCard.style.display = 'none';
    gateStateEl.textContent = '—';
    batteryEl.textContent = '—';
    if (state === 'Connect failed') statusDot.classList.add('error');
  } else if (state.startsWith('No audio') || state.startsWith('Playback fault') || state.startsWith('Audio stream error')) {
    // BLE may have silently dropped — show a clear error state
    statusDot.classList.add('error');
    connectBtn.textContent = 'Reconnect';
    connectBtn.classList.remove('connected');
  } else {
    // Connecting / settling / discovery
    statusDot.classList.add('connecting');
  }
});

on('battery', (pct, charging) => {
  let icon = '🔋';
  if (charging) icon = '⚡';
  else if (pct <= 10) icon = '🪫';
  batteryEl.textContent = `${icon} ${pct}%`;
});

on('gate', (name) => {
  gateStateEl.textContent = FRIENDLY_GATE[name] || name;
  const el = gateStateEl;
  el.classList.remove('live-state', 'muted-state');
  if (name === 'UnmutedLive') el.classList.add('live-state');
  else el.classList.add('muted-state');
});

on('audio', (pcm) => {
  lastAudioEventMs = Date.now();
  // RMS level from 160-sample PCM frame
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  const rms = Math.sqrt(sum / pcm.length);
  // Normalize to 0-1 (max 32768, but typical speech peaks ~8000-12000)
  const raw = Math.min(1, rms / 10000);
  // Smooth: fast attack, slow decay
  smoothLevel = raw > smoothLevel ? raw * 0.6 + smoothLevel * 0.4
                                  : raw * 0.15 + smoothLevel * 0.85;

  // Update ring
  const offset = CIRC * (1 - smoothLevel);
  volBar.style.strokeDashoffset = offset;

  // Color classes
  volBar.classList.remove('good', 'warm', 'hot', 'quiet');
  if (smoothLevel > 0.8)      volBar.classList.add('hot');
  else if (smoothLevel > 0.5) volBar.classList.add('warm');
  else if (smoothLevel > 0.15) volBar.classList.add('good');
  else                         volBar.classList.add('quiet');

  // Icon + label
  if (smoothLevel > 0.5)       { volIcon.textContent = '🔊'; volDesc.textContent = 'Loud & clear'; }
  else if (smoothLevel > 0.15) { volIcon.textContent = '🔉'; volDesc.textContent = 'Good level'; }
  else if (smoothLevel > 0.03) { volIcon.textContent = '🔈'; volDesc.textContent = 'A bit quiet'; }
  else                         { volIcon.textContent = '🔇'; volDesc.textContent = 'Silence'; }
});

on('flashProgress', (pct) => { flashProgress.value = pct; });
on('flashStatus', (msg) => { flashStatus.textContent = msg; });

// ── Volume decay ─────────────────────────────────────────────────────────
// When audio stops arriving the meter should decay to zero instead of
// freezing at the last displayed level.  This makes silence visible.
setInterval(() => {
  if (Date.now() - lastAudioEventMs > 400 && smoothLevel > 0.005) {
    smoothLevel *= 0.55;
    if (smoothLevel < 0.005) smoothLevel = 0;
    const offset = CIRC * (1 - smoothLevel);
    volBar.style.strokeDashoffset = offset;
    volBar.classList.remove('good', 'warm', 'hot');
    volBar.classList.add('quiet');
    volIcon.textContent = '🔇';
    volDesc.textContent = 'Silence';
  }
}, 200);

// ── Global error visibility ─────────────────────────────────────────────
// Prevent silent UI freezes: show a visible fault state for uncaught errors.
window.addEventListener('error', () => {
  connStateEl.textContent = 'UI error — refresh page';
  statusDot.className = 'status-dot error';
  connectBtn.textContent = 'Refresh';
  connectBtn.classList.remove('connected');
});

window.addEventListener('unhandledrejection', () => {
  connStateEl.textContent = 'UI error — refresh page';
  statusDot.className = 'status-dot error';
  connectBtn.textContent = 'Refresh';
  connectBtn.classList.remove('connected');
});

// ── Button handlers ──────────────────────────────────────────────────────
connectBtn.addEventListener('click', () => {
  connectBle().catch(() => {});
});

flashBtn.addEventListener('click', async () => {
  flashBtn.disabled = true;
  flashProgress.value = 0;
  try {
    await flashFirmware({ firmwareUrl: DEFAULT_FW_URL, eraseAll: true });
  } catch (e) {
    // flashStatus already shows the error; log to console for debugging
    console.error('Flash failed:', e);
  }
  flashBtn.disabled = false;
});

// ── Service worker ───────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); });
}
