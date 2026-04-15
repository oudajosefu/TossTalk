# build-all.ps1  — Build firmware + merged binary, then package both bridge executables.
# Run from the repo root:  .\scripts\build-all.ps1
#
# Prerequisites:
#   uv venv && uv pip install platformio esptool pyinstaller -r bridge/requirements.txt

param(
    [switch]$SkipFirmware,
    [switch]$SkipBridge
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot

Push-Location $RepoRoot
try {
    # ── 1. Firmware ──────────────────────────────────────────────────────
    if (-not $SkipFirmware) {
        Write-Host "`n=== Building and uploading firmware ===" -ForegroundColor Cyan
        uv run python -m platformio run -d firmware -t upload
        if ($LASTEXITCODE -ne 0) { throw "Firmware build/upload failed" }

        Write-Host "`n=== Merging firmware binary ===" -ForegroundColor Cyan
        uv run python scripts/merge_firmware.py `
            --env-dir firmware/.pio/build/xiao-esp32s3 `
            --out web/firmware/tosstalk-merged.bin
        if ($LASTEXITCODE -ne 0) { throw "Firmware merge failed" }

        Write-Host "Merged binary: web/firmware/tosstalk-merged.bin" -ForegroundColor Green
    }

    # ── 2. Bridge executables ────────────────────────────────────────────
    if (-not $SkipBridge) {
        Write-Host "`n=== Building bridge CLI ===" -ForegroundColor Cyan
        uv run pyinstaller bridge/tosstalk-bridge.spec --noconfirm
        if ($LASTEXITCODE -ne 0) { throw "Bridge CLI build failed" }

        Write-Host "`n=== Building bridge GUI ===" -ForegroundColor Cyan
        uv run pyinstaller bridge/tosstalk-bridge-gui.spec --noconfirm
        if ($LASTEXITCODE -ne 0) { throw "Bridge GUI build failed" }

        Write-Host "`nBridge executables:" -ForegroundColor Green
        Write-Host "  dist/tosstalk-bridge.exe"
        Write-Host "  dist/tosstalk-bridge-gui.exe"
    }

    Write-Host "`n=== Build complete ===" -ForegroundColor Green
}
finally {
    Pop-Location
}
