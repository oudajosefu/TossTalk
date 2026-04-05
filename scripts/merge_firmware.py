#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import pathlib
import subprocess
import sys


def find_boot_app0() -> pathlib.Path:
    candidates = []

    pkg_dir = os.environ.get("PLATFORMIO_PACKAGES_DIR")
    if pkg_dir:
        candidates.append(pathlib.Path(pkg_dir))

    candidates.append(pathlib.Path.home() / ".platformio" / "packages")

    for base in candidates:
        p = (
            base
            / "framework-arduinoespressif32"
            / "tools"
            / "partitions"
            / "boot_app0.bin"
        )
        if p.exists():
            return p

    raise FileNotFoundError("boot_app0.bin not found in PlatformIO package directories")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Merge ESP32-S3 firmware binaries into one flashable image"
    )
    parser.add_argument(
        "--env-dir",
        required=True,
        help="PlatformIO env output directory (contains firmware.bin)",
    )
    parser.add_argument("--out", required=True, help="Output merged bin path")
    parser.add_argument("--flash-mode", default="dio")
    parser.add_argument("--flash-freq", default="80m")
    parser.add_argument("--flash-size", default="8MB")
    args = parser.parse_args()

    env_dir = pathlib.Path(args.env_dir)
    out_path = pathlib.Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    bootloader = env_dir / "bootloader.bin"
    partitions = env_dir / "partitions.bin"
    app = env_dir / "firmware.bin"
    boot_app0 = find_boot_app0()

    required = [bootloader, partitions, app, boot_app0]
    missing = [str(p) for p in required if not p.exists()]
    if missing:
        raise FileNotFoundError(f"Missing required files: {missing}")

    cmd = [
        sys.executable,
        "-m",
        "esptool",
        "--chip",
        "esp32s3",
        "merge-bin",
        "-o",
        str(out_path),
        "--flash-mode",
        args.flash_mode,
        "--flash-freq",
        args.flash_freq,
        "--flash-size",
        args.flash_size,
        "0x0000",
        str(bootloader),
        "0x8000",
        str(partitions),
        "0xe000",
        str(boot_app0),
        "0x10000",
        str(app),
    ]

    subprocess.run(cmd, check=True)
    print(f"Merged firmware created: {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
