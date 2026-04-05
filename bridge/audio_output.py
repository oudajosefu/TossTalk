"""Audio output - resamples 8 kHz PCM and writes to a virtual audio device."""

import logging
import threading
import time
from collections import deque

import numpy as np
import sounddevice as sd
from scipy.signal import firwin, lfilter

log = logging.getLogger(__name__)

SAMPLE_RATE_IN = 8000
SAMPLE_RATE_OUT = 48000
SAMPLE_COUNT = 160
RESAMPLE_FACTOR = SAMPLE_RATE_OUT // SAMPLE_RATE_IN  # 6
FRAME_OUT_SAMPLES = SAMPLE_COUNT * RESAMPLE_FACTOR  # 960

# Jitter buffer limits (in frames)
TARGET_BUFFER = 6
MAX_BUFFER = 30

# FIR anti-alias filter for zero-stuff upsampling (maintains state across frames)
_NUM_FIR_TAPS = 12 * RESAMPLE_FACTOR + 1  # 73 taps
_FIR_COEFFS = firwin(_NUM_FIR_TAPS, 1.0 / RESAMPLE_FACTOR) * RESAMPLE_FACTOR


def find_vb_cable_device() -> int | None:
    """Find the VB-Cable input device index. Returns None if not found."""
    devices = sd.query_devices()
    for i, d in enumerate(devices):
        name = d["name"].lower()
        if "cable input" in name and d["max_output_channels"] > 0:
            return i
    return None


def list_output_devices() -> list[tuple[int, str]]:
    """List all output audio devices."""
    devices = sd.query_devices()
    result = []
    for i, d in enumerate(devices):
        if d["max_output_channels"] > 0:
            result.append((i, d["name"]))
    return result


class AudioOutput:
    """Threaded audio output that resamples 8 kHz PCM to 48 kHz and streams it."""

    def __init__(self, device_index: int | None = None):
        self._device_index = device_index
        self._queue: deque[np.ndarray] = deque(maxlen=MAX_BUFFER)
        self._stream: sd.OutputStream | None = None
        self._lock = threading.Lock()
        self._started = False
        self._underruns = 0
        self._prev_tail: np.ndarray | None = (
            None  # last few output samples for crossfade
        )
        # Stateful FIR filter for continuous resampling across frames
        self._filter_state = np.zeros(len(_FIR_COEFFS) - 1, dtype=np.float64)
        # Diagnostic counters
        self._enqueue_count = 0
        self._callback_count = 0
        self._shed_count = 0
        self._length_mismatch_count = 0
        self._clip_count = 0
        self._last_diag_time = 0.0
        self._last_enqueue_time = 0.0
        self._max_enqueue_gap_ms = 0.0
        self._min_enqueue_gap_ms = 999999.0
        self._last_callback_time = 0.0
        self._max_callback_gap_ms = 0.0
        self._discontinuity_count = 0

    def start(self) -> None:
        """Open the audio output stream."""
        if self._started:
            return

        device = self._device_index
        if device is None:
            device = find_vb_cable_device()
            if device is None:
                raise RuntimeError(
                    "VB-Cable not found. Install VB-Cable and restart, "
                    "or specify --output-device."
                )

        dev_info = sd.query_devices(device)
        log.info("Opening audio output: %s (device %d)", dev_info["name"], device)

        self._stream = sd.OutputStream(
            samplerate=SAMPLE_RATE_OUT,
            channels=1,
            dtype="float32",
            device=device,
            blocksize=FRAME_OUT_SAMPLES,
            callback=self._audio_callback,
            latency="low",
        )
        self._stream.start()
        self._started = True
        self._filter_state = np.zeros(len(_FIR_COEFFS) - 1, dtype=np.float64)
        log.info("Audio output stream started (48 kHz, mono, float32)")

    def stop(self) -> None:
        """Close the audio output stream."""
        if self._stream:
            try:
                self._stream.stop()
                self._stream.close()
            except Exception:
                pass
            self._stream = None
        self._started = False

    def enqueue(self, pcm_8k: np.ndarray) -> None:
        """Enqueue an 8 kHz int16 PCM frame for resampled output."""
        now = time.perf_counter()
        self._enqueue_count += 1

        # Track inter-frame timing
        if self._last_enqueue_time > 0:
            gap_ms = (now - self._last_enqueue_time) * 1000
            if gap_ms > self._max_enqueue_gap_ms:
                self._max_enqueue_gap_ms = gap_ms
            if gap_ms < self._min_enqueue_gap_ms:
                self._min_enqueue_gap_ms = gap_ms
        self._last_enqueue_time = now

        # Analyze input PCM
        pcm_abs_max = int(np.max(np.abs(pcm_8k)))
        pcm_rms = float(np.sqrt(np.mean(pcm_8k.astype(np.float64) ** 2)))
        pcm_is_silence = pcm_abs_max == 0
        pcm_is_clipped = pcm_abs_max >= 32700

        if pcm_is_clipped:
            self._clip_count += 1
            log.debug(
                "[AUDIO-IN] CLIPPED frame #%d: peak=%d rms=%.0f",
                self._enqueue_count,
                pcm_abs_max,
                pcm_rms,
            )

        # Resample 8 kHz → 48 kHz via zero-stuffing + stateful FIR lowpass
        pcm_float = pcm_8k.astype(np.float32) / 32768.0
        stuffed = np.zeros(len(pcm_float) * RESAMPLE_FACTOR, dtype=np.float64)
        stuffed[::RESAMPLE_FACTOR] = pcm_float
        pcm_48k, self._filter_state = lfilter(
            _FIR_COEFFS, [1.0], stuffed, zi=self._filter_state
        )
        pcm_48k = pcm_48k.astype(np.float32)

        # resample_poly may return slightly more/fewer than FRAME_OUT_SAMPLES
        # due to filter delay — pad or trim to exact size
        actual_len = len(pcm_48k)
        if actual_len != FRAME_OUT_SAMPLES:
            self._length_mismatch_count += 1
            if actual_len < FRAME_OUT_SAMPLES:
                pcm_48k = np.pad(pcm_48k, (0, FRAME_OUT_SAMPLES - actual_len))
            else:
                pcm_48k = pcm_48k[:FRAME_OUT_SAMPLES]

        # Clip to [-1, 1]
        over = float(np.max(np.abs(pcm_48k)))
        if over > 1.0:
            log.debug(
                "[RESAMPLE] Over-range after resample: peak=%.4f (frame #%d)",
                over,
                self._enqueue_count,
            )
        np.clip(pcm_48k, -1.0, 1.0, out=pcm_48k)

        # Check for discontinuity at frame boundary
        if self._prev_tail is not None and not pcm_is_silence:
            jump = abs(float(pcm_48k[0]) - float(self._prev_tail))
            if jump > 0.1:
                self._discontinuity_count += 1
                log.debug(
                    "[BOUNDARY] Discontinuity frame #%d: jump=%.4f (prev_tail=%.4f, new_head=%.4f)",
                    self._enqueue_count,
                    jump,
                    float(self._prev_tail),
                    float(pcm_48k[0]),
                )
        self._prev_tail = pcm_48k[-1] if len(pcm_48k) > 0 else None

        with self._lock:
            self._queue.append(pcm_48k)

        # Periodic diagnostics (every 2 seconds)
        if now - self._last_diag_time >= 2.0:
            self._last_diag_time = now
            with self._lock:
                qdepth = len(self._queue)
            log.debug(
                "[AUDIO-DIAG] enqueued=%d callbacks=%d buf=%d underruns=%d shed=%d "
                "len_mismatch=%d clips=%d discont=%d "
                "enqueue_gap=[%.1f-%.1f]ms max_cb_gap=%.1fms",
                self._enqueue_count,
                self._callback_count,
                qdepth,
                self._underruns,
                self._shed_count,
                self._length_mismatch_count,
                self._clip_count,
                self._discontinuity_count,
                self._min_enqueue_gap_ms if self._min_enqueue_gap_ms < 999999 else 0,
                self._max_enqueue_gap_ms,
                self._max_callback_gap_ms,
            )
            # Reset peak trackers
            self._max_enqueue_gap_ms = 0.0
            self._min_enqueue_gap_ms = 999999.0
            self._max_callback_gap_ms = 0.0

    def _audio_callback(
        self,
        outdata: np.ndarray,
        frames: int,
        _time_info: object,
        status: sd.CallbackFlags,
    ) -> None:
        """Called by sounddevice to fill the output buffer."""
        now = time.perf_counter()
        self._callback_count += 1
        if self._last_callback_time > 0:
            gap_ms = (now - self._last_callback_time) * 1000
            if gap_ms > self._max_callback_gap_ms:
                self._max_callback_gap_ms = gap_ms
        self._last_callback_time = now

        if status:
            log.warning("[CALLBACK] sounddevice status: %s", status)

        with self._lock:
            if self._queue:
                # Shed excess frames to keep latency bounded
                shed = 0
                while len(self._queue) > TARGET_BUFFER + 4:
                    self._queue.popleft()
                    shed += 1
                if shed:
                    self._shed_count += shed
                    log.debug(
                        "[CALLBACK] Shed %d excess frames (queue was %d)",
                        shed,
                        shed + len(self._queue),
                    )
                frame = self._queue.popleft()
            else:
                frame = None

        if frame is not None:
            # frame is (FRAME_OUT_SAMPLES,), outdata is (frames, 1)
            n = min(len(frame), frames)
            outdata[:n, 0] = frame[:n]
            if n < frames:
                outdata[n:, 0] = 0.0
        else:
            outdata[:, 0] = 0.0
            self._underruns += 1
            if self._underruns <= 20 or self._underruns % 50 == 0:
                log.debug("[CALLBACK] Underrun #%d", self._underruns)

    @property
    def buffer_depth(self) -> int:
        with self._lock:
            return len(self._queue)

    @property
    def underruns(self) -> int:
        return self._underruns
