# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for TossTalk Virtual Microphone Bridge."""

import sys
from pathlib import Path

block_cipher = None

a = Analysis(
    ['bridge/main.py'],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=[
        'bleak.backends.winrt',
        'bleak.backends.winrt.scanner',
        'bleak.backends.winrt.client',
        # sounddevice uses _sounddevice_data for PortAudio
        'sounddevice',
        '_sounddevice_data',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='tosstalk-bridge',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
