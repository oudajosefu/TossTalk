"""IMA ADPCM decoder - ported from web/core.js."""

import numpy as np

INDEX_TABLE = np.array(
    [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8],
    dtype=np.int32,
)

STEP_TABLE = np.array(
    [
        7,
        8,
        9,
        10,
        11,
        12,
        13,
        14,
        16,
        17,
        19,
        21,
        23,
        25,
        28,
        31,
        34,
        37,
        41,
        45,
        50,
        55,
        60,
        66,
        73,
        80,
        88,
        97,
        107,
        118,
        130,
        143,
        157,
        173,
        190,
        209,
        230,
        253,
        279,
        307,
        337,
        371,
        408,
        449,
        494,
        544,
        598,
        658,
        724,
        796,
        876,
        963,
        1060,
        1166,
        1282,
        1411,
        1552,
        1707,
        1878,
        2066,
        2272,
        2499,
        2749,
        3024,
        3327,
        3660,
        4026,
        4428,
        4871,
        5358,
        5894,
        6484,
        7132,
        7845,
        8630,
        9493,
        10442,
        11487,
        12635,
        13899,
        15289,
        16818,
        18500,
        20350,
        22385,
        24623,
        27086,
        29794,
        32767,
    ],
    dtype=np.int32,
)


def decode(
    data: bytes | bytearray, count: int, predictor: int, index: int
) -> np.ndarray:
    """Decode IMA ADPCM data to signed 16-bit PCM samples.

    Args:
        data: ADPCM encoded bytes (80 bytes for a standard 160-sample frame).
        count: Number of PCM samples to produce.
        predictor: Initial predictor value (int16 from frame header).
        index: Initial step-table index (uint8, 0-88 from frame header).

    Returns:
        numpy int16 array of *count* samples.
    """
    out = np.empty(count, dtype=np.int16)
    pred = int(predictor)
    idx = max(0, min(88, int(index)))
    o = 0

    for i in range(len(data)):
        if o >= count:
            break
        b = data[i]
        # Low nibble first, then high nibble
        for nib in (b & 0x0F, (b >> 4) & 0x0F):
            step = int(STEP_TABLE[idx])
            diff = step >> 3
            if nib & 1:
                diff += step >> 2
            if nib & 2:
                diff += step >> 1
            if nib & 4:
                diff += step
            if nib & 8:
                pred -= diff
            else:
                pred += diff
            pred = max(-32768, min(32767, pred))
            idx += int(INDEX_TABLE[nib])
            idx = max(0, min(88, idx))
            out[o] = pred
            o += 1
            if o >= count:
                break

    # Zero-fill if we ran out of data early
    if o < count:
        out[o:] = 0
    return out
