# -*- mode: python ; coding: utf-8 -*-


a = Analysis(
    ['desktop_app.py'],
    pathex=[],
    binaries=[],
    datas=[('ocr', 'ocr'), ('privacy', 'privacy'), ('local_storage', 'local_storage'), ('wayland_screenshot.py', '.'), ('desktop_app_linux.py', '.')],
    hiddenimports=['ewmh', 'Xlib', 'dbus', 'gi', 'fcntl', 'local_storage', 'local_storage.sqlite_manager', 'local_storage.session_tracker', 'local_storage.batch_uploader'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='timetracker',
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
