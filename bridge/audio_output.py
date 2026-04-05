"""Audio output - resamples 8 kHz PCM and writes to a virtual audio device."""

import logging
import threading
from collections import deque

import numpy as np
import sounddevice as sd
from scipy.signal import resample

log = logging.getLogger(__name__)

SAMPLE_RATE_IN = 8000
SAMPLE_RATE_OUT = 48000
SAMPLE_COUNT = 160
RESAMPLE_FACTOR = SAMPLE_RATE_OUT // SAMPLE_RATE_IN  # 6
FRAME_OUT_SAMPLES = SAMPLE_COUNT * RESAMPLE_FACTOR  # 960

# Jitter buffer limits (in frames)
TARGET_BUFFER = 6
MAX_BUFFER = 30


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
        # Resample 8 kHz → 48 kHz
        pcm_float = pcm_8k.astype(np.float32) / 32768.0
        pcm_48k = np.asarray(resample(pcm_float, FRAME_OUT_SAMPLES), dtype=np.float32)
        # Clip to [-1, 1] to avoid distortion
        np.clip(pcm_48k, -1.0, 1.0, out=pcm_48k)

        with self._lock:
            self._queue.append(pcm_48k)

    def _audio_callback(
        self,
        outdata: np.ndarray,
        frames: int,
        _time_info: object,
        _status: sd.CallbackFlags,
    ) -> None:
        """Called by sounddevice to fill the output buffer."""
        with self._lock:
            if self._queue:
                # Shed excess frames to keep latency bounded
                while len(self._queue) > TARGET_BUFFER + 4:
                    self._queue.popleft()
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

    @property
    def buffer_depth(self) -> int:
        with self._lock:
            return len(self._queue)

    @property
    def underruns(self) -> int:
        return self._underruns
