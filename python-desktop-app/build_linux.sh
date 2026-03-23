#!/usr/bin/env bash
# =============================================================================
# JIRAForge Time Tracker — Linux PyInstaller Build Script
# =============================================================================

set -euo pipefail

echo "[BUILD] Building TimeTracker for Linux..."

pyinstaller --onefile \
    --name timetracker \
    --add-data "ocr:ocr" \
    --add-data "privacy:privacy" \
    --add-data "local_storage:local_storage" \
    --add-data "wayland_screenshot.py:." \
    --add-data "desktop_app_linux.py:." \
    --hidden-import ewmh \
    --hidden-import Xlib \
    --hidden-import dbus \
    --hidden-import gi \
    --hidden-import fcntl \
    --hidden-import local_storage \
    --hidden-import local_storage.sqlite_manager \
    --hidden-import local_storage.session_tracker \
    --hidden-import local_storage.batch_uploader \
    desktop_app.py

echo "[BUILD] Done. Binary at dist/timetracker"
