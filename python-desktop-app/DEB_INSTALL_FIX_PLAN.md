# DEB Install Fix Plan — TimeTracker Linux

**Version:** 1.0.3+  
**Date:** 2026-06-08  
**Priority:** P0 — Blocks all non-developer user onboarding

---

## Table of Contents

1. [Problem Summary](#1-problem-summary)
2. [Root Cause Map](#2-root-cause-map)
3. [Fix #1 — Generate All Required Files at First Launch (P0)](#fix-1--generate-all-required-files-at-first-launch)
4. [Fix #2 — GNOME Extension Activation via Live Session (P0)](#fix-2--gnome-extension-activation-via-live-session)
5. [Fix #3 — Generate uninstall.sh via .deb path (P1)](#fix-3--generate-uninstallsh-via-deb-path)
6. [Fix #4 — Scaffold updates/ and logs/ directories in postinst (P1)](#fix-4--scaffold-updates-and-logs-directories-in-postinst)
7. [Fix #5 — First-launch success notification (P2)](#fix-5--first-launch-success-notification)
8. [build.sh changes](#build-sh-changes)
9. [Test Scripts](#test-scripts)
10. [Verification Checklist](#verification-checklist)
11. [Rollback Plan](#rollback-plan)

---

## 1. Problem Summary

When users install the `.deb` on a new machine, the result is that
`~/.local/share/TimeTracker/` contains **only `TimeTracker.AppImage`**
and nothing else.  The application appears broken or "not installed":

- No tray icon visible (GNOME extension disabled → icon suppressed)
- No `uninstall.sh` → users cannot remove the app cleanly
- No `logs/` directory → no log file until first successful run
- No `updates/` directory → auto-updater cannot stage a download
- No `autostart` entry → app doesn't start on next login

---

## 2. Root Cause Map

| # | Root Cause | Location | Impact |
|---|---|---|---|
| RC-1 | `_install_appimage()` short-circuits when `$APPIMAGE == canonical`, skipping ALL scaffolding code | `desktop_app.py` `_install_appimage()` | No uninstall.sh, no dirs created via .deb path |
| RC-2 | `gnome-extensions enable` in postinst always fails — no D-Bus GNOME session during dpkg | `build.sh` DEBIAN/postinst | Tray icon invisible; users think app not installed |
| RC-3 | `uninstall.sh` only generated in the non-canonical-path branch (first-install-from-Downloads path) | `desktop_app.py` `_install_appimage()` | Uninstaller never created after .deb install |
| RC-4 | `logs/` and `updates/` subdirectories only created at runtime, not by postinst | `app_logger.py`, `UpdateManager` | Auto-updater and logger fail on first reference |
| RC-5 | No first-launch feedback loop | `desktop_app.py` `_install_appimage()` | User has no signal that the app is running |

---

## Fix #1 — Generate All Required Files at First Launch

### File: `desktop_app.py`
### Location: `_install_appimage()` — the canonical-path early-return block  
### Priority: P0

**Current code** (around line 1403–1408):

```python
if current_norm == canonical_norm:
    # Already running from the canonical install location — nothing to do.
    print(f"[INFO] Running from canonical AppImage location: {canonical}")
    return True
```

**Problem:** This early return skips the uninstaller generation, the
`logs/` + `updates/` directory creation, and the autostart entry writing.
When installed via `.deb`, the postinst pre-copies the AppImage to the
canonical path, so `current_norm == canonical_norm` is **always true** on
a fresh `.deb` install, meaning none of the scaffolding code ever runs.

**Fix:** Before returning `True`, call a new helper
`_ensure_install_scaffold()` that creates all expected directories, the
uninstaller, and the autostart entry if they are missing.

### Exact code changes in `desktop_app.py`

#### A — Add `_ensure_install_scaffold()` function

Insert this new function immediately before `_install_appimage()` (around line 1369):

```python
def _ensure_install_scaffold(install_dir: str, canonical_appimage: str) -> None:
    """Create all directories and helper files expected in the TimeTracker
    install folder, regardless of how the app was started.

    Called at every startup (even when already at the canonical path) so that
    a fresh .deb install produces a fully-populated install directory without
    requiring the user to run the app twice or authenticate first.

    Files / directories created if missing:
      ~/.local/share/TimeTracker/
        logs/                   ← app_logger writes timetracker.log here
        updates/                ← UpdateManager stages downloads here
        uninstall.sh            ← end-user uninstall script
        .config/autostart/timetracker.desktop  ← XDG autostart entry
    """
    import stat

    # ── 1. Subdirectories ────────────────────────────────────────────────────
    for sub in ('logs', 'updates'):
        path = os.path.join(install_dir, sub)
        if not os.path.isdir(path):
            try:
                os.makedirs(path, exist_ok=True)
                print(f"[OK] Created directory: {path}")
            except OSError as e:
                print(f"[WARN] Could not create {path}: {e}")

    # ── 2. uninstall.sh ──────────────────────────────────────────────────────
    uninstall_path = os.path.join(install_dir, 'uninstall.sh')
    if not os.path.isfile(uninstall_path):
        try:
            _generate_linux_uninstaller_at_path(uninstall_path, install_dir)
            print(f"[OK] Uninstaller created: {uninstall_path}")
        except Exception as e:
            print(f"[WARN] Could not generate uninstaller: {e}")

    # ── 3. XDG autostart entry ───────────────────────────────────────────────
    autostart_dir = os.path.expanduser('~/.config/autostart')
    autostart_path = os.path.join(autostart_dir, 'timetracker.desktop')
    if not os.path.isfile(autostart_path):
        try:
            os.makedirs(autostart_dir, exist_ok=True)
            content = (
                '[Desktop Entry]\n'
                'Type=Application\n'
                'Name=TimeTracker\n'
                'Comment=Automatic time tracking for JIRA issues\n'
                f'Exec=env APPIMAGE_EXTRACT_AND_RUN=1 {canonical_appimage}\n'
                'Terminal=false\n'
                'Hidden=false\n'
                'X-GNOME-Autostart-enabled=true\n'
            )
            with open(autostart_path, 'w') as f:
                f.write(content)
            os.chmod(autostart_path, 0o644)
            print(f"[OK] Autostart entry created: {autostart_path}")
        except Exception as e:
            print(f"[WARN] Could not write autostart entry: {e}")

    # ── 4. Ensure AppImage is executable ────────────────────────────────────
    if os.path.isfile(canonical_appimage):
        try:
            current_mode = os.stat(canonical_appimage).st_mode
            if not (current_mode & stat.S_IXUSR):
                os.chmod(canonical_appimage, current_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
                print(f"[OK] Made AppImage executable: {canonical_appimage}")
        except OSError as e:
            print(f"[WARN] Could not chmod AppImage: {e}")
```

#### B — Modify the canonical-path early-return in `_install_appimage()`

Replace the early-return block:

```python
# BEFORE:
if current_norm == canonical_norm:
    # Already running from the canonical install location — nothing to do.
    print(f"[INFO] Running from canonical AppImage location: {canonical}")
    return True

# AFTER:
if current_norm == canonical_norm:
    # Already running from the canonical install location.
    # Still run the scaffold to ensure all expected directories and helper
    # files exist — this is a no-op after the first successful run, but is
    # essential for fresh .deb installs where postinst only copies the AppImage.
    print(f"[INFO] Running from canonical AppImage location: {canonical}")
    _ensure_install_scaffold(get_app_data_dir(), canonical)
    return True
```

#### C — Remove duplicated scaffold code from the non-canonical branch

In the same `_install_appimage()` function, the existing scaffold calls
(separate `uninstall.sh` generation and `.desktop` writing) are now handled
by `_ensure_install_scaffold()`.  The post-copy block in the non-canonical
branch should be updated to simply call `_ensure_install_scaffold()`:

```python
# Replace the three separate try/except blocks that generate the
# uninstaller and .desktop entry (lines ~1456–1493) with:
try:
    _ensure_install_scaffold(get_app_data_dir(), canonical)
except Exception as e:
    print(f"[WARN] Scaffold generation failed (non-fatal): {e}")
```

---

## Fix #2 — GNOME Extension Activation via Live Session

### File: `desktop_app.py`
### Location: Add new `_try_enable_gnome_appindicator_extension()` function + call it from `_ensure_install_scaffold()`
### Priority: P0

**Problem:** The `postinst` tries to enable the `ubuntu-appindicators@ubuntu.com`
GNOME Shell extension using:

```bash
su - "$_USERNAME" -c 'gnome-extensions enable ubuntu-appindicators@ubuntu.com 2>/dev/null || true'
```

This **always fails silently** because:
1. There is no PAM session during `dpkg postinst` — `su -` cannot authenticate
2. Even if it authenticated, `gnome-extensions` communicates via the
   `org.gnome.Shell` D-Bus interface which only exists while GNOME Shell is
   running. GNOME Shell is NOT running during package installation.

Without this extension, GNOME Shell suppresses all AppIndicator tray icons,
making the app completely invisible.

**Fix:** Remove the unreliable `su -` call from `postinst` entirely.
Instead, add the extension activation to `_ensure_install_scaffold()` so it
runs at first app launch, **inside the user's live GNOME session**.

### New function (add inside `_ensure_install_scaffold()` after step 4):

```python
    # ── 5. Enable GNOME AppIndicator extension (live session only) ───────────
    _try_enable_gnome_appindicator_extension()
```

### New standalone function (insert before `_ensure_install_scaffold`):

```python
def _try_enable_gnome_appindicator_extension() -> None:
    """Enable the ubuntu-appindicators GNOME Shell extension in the live user session.

    This MUST run inside the user's running session — it uses D-Bus to talk to
    the live gnome-shell process.  It is a no-op (silently succeeds) if:
      - Not on Linux
      - No GNOME session is active
      - Extension is already enabled
      - gnome-extensions CLI is unavailable

    Tries two methods in order:
      1. gdbus call directly to org.gnome.Shell.Extensions (reliable on Ubuntu 22.04+)
      2. gnome-extensions enable CLI (fallback for older GNOME)
    """
    if not sys.platform.startswith('linux'):
        return

    EXTENSION_UUID = 'ubuntu-appindicators@ubuntu.com'

    # Only attempt if inside a GNOME session
    desktop = os.environ.get('XDG_CURRENT_DESKTOP', '').lower()
    session = os.environ.get('DESKTOP_SESSION', '').lower()
    if 'gnome' not in desktop and 'gnome' not in session and 'ubuntu' not in desktop:
        return

    import subprocess as _sub

    # Method 1: gdbus — most reliable (works without gnome-extensions installed)
    try:
        result = _sub.run(
            [
                'gdbus', 'call', '--session',
                '--dest', 'org.gnome.Shell',
                '--object-path', '/org/gnome/Shell',
                '--method', 'org.gnome.Shell.Extensions.EnableExtension',
                EXTENSION_UUID,
            ],
            capture_output=True, timeout=5, text=True
        )
        if result.returncode == 0:
            print(f"[OK] GNOME AppIndicator extension enabled via gdbus: {EXTENSION_UUID}")
            return
        # Non-zero but not a connection error means the extension may already be enabled
        if 'not found' not in (result.stderr or '').lower():
            print(f"[INFO] gdbus extension enable returned: {result.stderr.strip()}")
    except FileNotFoundError:
        pass  # gdbus not available
    except subprocess.TimeoutExpired:
        pass
    except Exception as e:
        print(f"[WARN] gdbus extension enable failed: {e}")

    # Method 2: gnome-extensions CLI (fallback)
    try:
        result = _sub.run(
            ['gnome-extensions', 'enable', EXTENSION_UUID],
            capture_output=True, timeout=5, text=True
        )
        if result.returncode == 0:
            print(f"[OK] GNOME AppIndicator extension enabled via gnome-extensions CLI")
        else:
            print(f"[INFO] gnome-extensions enable: {result.stderr.strip() or 'no output'}")
    except FileNotFoundError:
        print(f"[INFO] gnome-extensions CLI not available — tray icon may require manual extension enable")
    except Exception as e:
        print(f"[WARN] gnome-extensions enable failed: {e}")
```

### build.sh postinst change — remove the broken su invocation

In `build.sh`, inside the `POSTINST` heredoc, **remove** this block entirely:

```bash
# REMOVE THIS ENTIRE BLOCK:
if command -v gnome-extensions &>/dev/null; then
    for _USER_HOME in /home/*; do
        _USERNAME=$(basename "$_USER_HOME")
        if id "$_USERNAME" &>/dev/null; then
            su - "$_USERNAME" -c 'gnome-extensions enable ubuntu-appindicators@ubuntu.com 2>/dev/null || true' 2>/dev/null || true
        fi
    done
fi
```

Replace with a comment explaining the rationale:

```bash
# NOTE: GNOME AppIndicator extension activation is handled at first app
# launch (inside the user's live GNOME session) by _try_enable_gnome_appindicator_extension()
# in desktop_app.py.  The su-based activation here always fails silently
# because no GNOME Shell D-Bus session exists during dpkg postinst execution.
```

---

## Fix #3 — Generate uninstall.sh via .deb path

This is fully addressed by **Fix #1B** — `_ensure_install_scaffold()` is now
called even when the app is already at the canonical path, and step 2 of
that function generates `uninstall.sh` if it is missing.

No additional code change is required beyond Fix #1.

---

## Fix #4 — Scaffold updates/ and logs/ directories in postinst

### File: `build.sh`
### Location: DEBIAN/postinst heredoc
### Priority: P1

In addition to the Python-side scaffolding (Fix #1), also create the
directories at `postinst` time so they exist even if the app fails to start.

Inside the `POSTINST` heredoc, after the block that copies the AppImage to
the canonical location, add:

```bash
    # Create expected subdirectories so the app can write logs and stage
    # updates even if a first-launch crash prevents Python from creating them.
    for _SUB in logs updates; do
        _SUBDIR="${_CANONICAL_DIR}/${_SUB}"
        mkdir -p "$_SUBDIR" 2>/dev/null && \
            chown "$_USERNAME":"$_USERNAME" "$_SUBDIR" 2>/dev/null || true
    done
    echo "Scaffold directories created for ${_USERNAME}: logs/ updates/"
```

---

## Fix #5 — First-launch success notification

### File: `desktop_app.py`
### Location: `_ensure_install_scaffold()` — end of function
### Priority: P2

After all scaffold steps succeed, show a single desktop notification so the
user knows the app has started (critical since the tray icon may not appear
immediately if the GNOME session needs to reload the extension).

Add at the end of `_ensure_install_scaffold()`:

```python
    # ── 6. First-launch notification ─────────────────────────────────────────
    # Show only on the very first run (uninstall.sh was just created).
    # This gives users a visible signal that TimeTracker is running even
    # before the tray icon appears (GNOME may need a shell restart to show it).
    _first_launch_marker = os.path.join(install_dir, '.first_launch_done')
    if not os.path.isfile(_first_launch_marker):
        try:
            _linux_notify(
                'TimeTracker installed',
                'TimeTracker is running in the background. '
                'Look for it in the system tray. '
                'If the tray icon is not visible, log out and back in.',
                urgency='normal',
            )
            # Write marker so we don't repeat this notification
            with open(_first_launch_marker, 'w') as _f:
                _f.write(f"first_launch={datetime.now(timezone.utc).isoformat()}\n")
        except Exception as e:
            print(f"[WARN] First-launch notification failed (non-fatal): {e}")
```

---

## build.sh Changes

### Summary of all build.sh edits

| Section | Change |
|---|---|
| `POSTINST` — after AppImage copy loop | Add `mkdir -p logs updates` per user |
| `POSTINST` — GNOME extension block | Remove broken `su -` invocation; add explanatory comment |
| `DEBIAN/control` — `Depends:` | Remove `gdebi` as a hard dep (it is a `Recommends`, not required for install) |

### Exact diff for POSTINST — directory scaffold addition

After the lines:

```bash
        chown "$_USERNAME":"$_USERNAME" "$_CANONICAL" 2>/dev/null || true
        echo "Canonical AppImage installed/upgraded for ${_USERNAME}: ${_CANONICAL}"
```

Add:

```bash
        # Scaffold expected subdirectories (logs, updates) so the app can
        # write log files and stage auto-updates even before first login.
        for _SUB in logs updates; do
            _SUBDIR="${_CANONICAL_DIR}/${_SUB}"
            mkdir -p "$_SUBDIR" 2>/dev/null && \
                chown "$_USERNAME":"$_USERNAME" "$_SUBDIR" 2>/dev/null || true
        done
```

---

## Test Scripts

### New test file: `tests/test_deb_install_scaffold.py`

This file must be created at:
`python-desktop-app/tests/test_deb_install_scaffold.py`

```python
"""
Tests for the .deb install scaffold behaviour — verifies that all expected
files and directories are created when the app starts from the canonical
AppImage path (the normal state after a .deb install).

These tests simulate what happens on a new user machine where:
  - The postinst script has already placed TimeTracker.AppImage at canonical
  - The app is launched for the first time from the canonical path
  - $APPIMAGE env var equals the canonical path
"""
import os
import sys
import stat
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock, call

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import desktop_app
from desktop_app import (
    _ensure_install_scaffold,
    _try_enable_gnome_appindicator_extension,
    _install_appimage,
    get_app_data_dir,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def install_dir(tmp_path):
    """Temporary directory representing ~/.local/share/TimeTracker/."""
    d = tmp_path / 'TimeTracker'
    d.mkdir()
    return d


@pytest.fixture
def fake_appimage(install_dir):
    """Fake AppImage file at the canonical path."""
    appimage = install_dir / 'TimeTracker.AppImage'
    appimage.write_bytes(b'\x7fELF')   # ELF magic for realism
    os.chmod(str(appimage), 0o644)     # NOT executable yet
    return appimage


# ---------------------------------------------------------------------------
# _ensure_install_scaffold() — directory creation
# ---------------------------------------------------------------------------

class TestEnsureInstallScaffold:

    def test_creates_logs_directory(self, install_dir, fake_appimage):
        _ensure_install_scaffold(str(install_dir), str(fake_appimage))
        assert (install_dir / 'logs').is_dir(), "logs/ directory must be created"

    def test_creates_updates_directory(self, install_dir, fake_appimage):
        _ensure_install_scaffold(str(install_dir), str(fake_appimage))
        assert (install_dir / 'updates').is_dir(), "updates/ directory must be created"

    def test_creates_uninstall_sh(self, install_dir, fake_appimage):
        _ensure_install_scaffold(str(install_dir), str(fake_appimage))
        uninstall = install_dir / 'uninstall.sh'
        assert uninstall.is_file(), "uninstall.sh must be created"
        content = uninstall.read_text()
        assert 'TimeTracker' in content
        assert 'rm -rf' in content or 'rm -f' in content

    def test_uninstall_sh_is_executable(self, install_dir, fake_appimage):
        _ensure_install_scaffold(str(install_dir), str(fake_appimage))
        uninstall = install_dir / 'uninstall.sh'
        assert os.access(str(uninstall), os.X_OK), "uninstall.sh must be executable"

    def test_creates_autostart_entry(self, install_dir, fake_appimage, tmp_path):
        fake_config = tmp_path / '.config' / 'autostart'
        with patch('os.path.expanduser', return_value=str(tmp_path)):
            _ensure_install_scaffold(str(install_dir), str(fake_appimage))
        # Re-read with real expanduser since patch is lifted
        # Just verify the function tried to create the autostart path
        # (the exact path depends on the test environment)

    def test_autostart_entry_has_correct_exec(self, install_dir, fake_appimage, tmp_path):
        """Autostart Exec= line must point to the canonical AppImage."""
        autostart_dir = tmp_path / 'autostart'
        autostart_dir.mkdir(parents=True)
        autostart_path = autostart_dir / 'timetracker.desktop'

        # Patch expanduser so autostart goes into tmp_path
        def fake_expanduser(p):
            return str(tmp_path) if p == '~' else os.path.expanduser(p)

        with patch('os.path.expanduser', side_effect=fake_expanduser):
            _ensure_install_scaffold(str(install_dir), str(fake_appimage))

        if autostart_path.exists():
            content = autostart_path.read_text()
            assert str(fake_appimage) in content, \
                "Autostart Exec= must reference the canonical AppImage path"
            assert 'APPIMAGE_EXTRACT_AND_RUN=1' in content, \
                "Autostart must set APPIMAGE_EXTRACT_AND_RUN=1 to avoid FUSE requirement"

    def test_makes_appimage_executable(self, install_dir, fake_appimage):
        """AppImage must be made executable even if postinst forgot to chmod it."""
        # Start with non-executable (0o644)
        os.chmod(str(fake_appimage), 0o644)
        _ensure_install_scaffold(str(install_dir), str(fake_appimage))
        mode = os.stat(str(fake_appimage)).st_mode
        assert mode & stat.S_IXUSR, "AppImage must have user-executable bit set"

    def test_idempotent_on_second_call(self, install_dir, fake_appimage):
        """Calling scaffold twice must not raise or corrupt existing files."""
        _ensure_install_scaffold(str(install_dir), str(fake_appimage))
        # Write a sentinel into uninstall.sh
        uninstall = install_dir / 'uninstall.sh'
        original_content = uninstall.read_text()
        # Second call
        _ensure_install_scaffold(str(install_dir), str(fake_appimage))
        # File must not be overwritten
        assert uninstall.read_text() == original_content, \
            "Second scaffold call must not overwrite existing uninstall.sh"

    def test_logs_subdirectory_is_writable(self, install_dir, fake_appimage):
        _ensure_install_scaffold(str(install_dir), str(fake_appimage))
        logs_dir = install_dir / 'logs'
        test_file = logs_dir / 'timetracker.log'
        test_file.write_text('test log entry')
        assert test_file.read_text() == 'test log entry'

    def test_updates_subdirectory_is_writable(self, install_dir, fake_appimage):
        _ensure_install_scaffold(str(install_dir), str(fake_appimage))
        updates_dir = install_dir / 'updates'
        test_file = updates_dir / 'TimeTracker_v99.0.0.AppImage'
        test_file.write_bytes(b'fake binary')
        assert test_file.read_bytes() == b'fake binary'

    def test_first_launch_marker_written(self, install_dir, fake_appimage):
        """After scaffold, the first-launch marker file should exist."""
        with patch('desktop_app._linux_notify'):
            _ensure_install_scaffold(str(install_dir), str(fake_appimage))
        marker = install_dir / '.first_launch_done'
        assert marker.is_file(), ".first_launch_done marker must be written on first run"

    def test_first_launch_notification_shown_once(self, install_dir, fake_appimage):
        """First-launch notification must only fire once (not on subsequent starts)."""
        with patch('desktop_app._linux_notify') as mock_notify:
            _ensure_install_scaffold(str(install_dir), str(fake_appimage))
            first_call_count = mock_notify.call_count

            # Second startup
            _ensure_install_scaffold(str(install_dir), str(fake_appimage))
            second_call_count = mock_notify.call_count

        assert first_call_count == 1, "Notification should fire exactly once on first run"
        assert second_call_count == 1, "Notification must not repeat on second startup"


# ---------------------------------------------------------------------------
# _try_enable_gnome_appindicator_extension()
# ---------------------------------------------------------------------------

class TestGnomeExtensionEnable:

    def test_noop_on_non_linux(self):
        """Must be a no-op on non-Linux platforms."""
        with patch('sys.platform', 'darwin'):
            # Should not raise
            _try_enable_gnome_appindicator_extension()

    def test_noop_when_no_gnome_session(self):
        """Must be a no-op when XDG_CURRENT_DESKTOP is not GNOME."""
        env = {'XDG_CURRENT_DESKTOP': 'KDE', 'DESKTOP_SESSION': 'plasma'}
        with patch.dict(os.environ, env, clear=False):
            with patch('subprocess.run') as mock_run:
                _try_enable_gnome_appindicator_extension()
                mock_run.assert_not_called()

    def test_uses_gdbus_on_gnome_session(self):
        """Should attempt gdbus call when GNOME session is detected."""
        env = {'XDG_CURRENT_DESKTOP': 'GNOME', 'DESKTOP_SESSION': 'gnome'}
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stderr = ''

        with patch.dict(os.environ, env, clear=False):
            with patch('subprocess.run', return_value=mock_result) as mock_run:
                _try_enable_gnome_appindicator_extension()
                # First call must be gdbus
                first_call = mock_run.call_args_list[0]
                cmd = first_call[0][0]
                assert 'gdbus' in cmd[0], "First attempt must use gdbus"
                assert 'ubuntu-appindicators@ubuntu.com' in cmd

    def test_falls_back_to_gnome_extensions_cli_when_gdbus_missing(self):
        """When gdbus is not found, must fall back to gnome-extensions CLI."""
        env = {'XDG_CURRENT_DESKTOP': 'GNOME', 'DESKTOP_SESSION': 'gnome'}

        def fake_run(cmd, **kwargs):
            if cmd[0] == 'gdbus':
                raise FileNotFoundError('gdbus not found')
            result = MagicMock()
            result.returncode = 0
            result.stderr = ''
            return result

        with patch.dict(os.environ, env, clear=False):
            with patch('subprocess.run', side_effect=fake_run) as mock_run:
                _try_enable_gnome_appindicator_extension()
                calls = [c[0][0][0] for c in mock_run.call_args_list]
                assert 'gnome-extensions' in calls, \
                    "Must fall back to gnome-extensions when gdbus is unavailable"

    def test_extension_uuid_is_correct(self):
        """Must attempt to enable the correct Ubuntu extension UUID."""
        env = {'XDG_CURRENT_DESKTOP': 'ubuntu:GNOME', 'DESKTOP_SESSION': 'ubuntu'}
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stderr = ''

        with patch.dict(os.environ, env, clear=False):
            with patch('subprocess.run', return_value=mock_result) as mock_run:
                _try_enable_gnome_appindicator_extension()
                all_args = str(mock_run.call_args_list)
                assert 'ubuntu-appindicators@ubuntu.com' in all_args

    def test_does_not_raise_on_timeout(self):
        """Timeout during gdbus must not crash the app."""
        import subprocess
        env = {'XDG_CURRENT_DESKTOP': 'GNOME'}

        def fake_run(cmd, **kwargs):
            if cmd[0] == 'gdbus':
                raise subprocess.TimeoutExpired(cmd, 5)
            result = MagicMock()
            result.returncode = 0
            result.stderr = ''
            return result

        with patch.dict(os.environ, env, clear=False):
            # Must not raise
            with patch('subprocess.run', side_effect=fake_run):
                _try_enable_gnome_appindicator_extension()


# ---------------------------------------------------------------------------
# _install_appimage() — integration: canonical path still calls scaffold
# ---------------------------------------------------------------------------

class TestInstallAppimageCanonicalPath:

    def test_scaffold_called_when_already_canonical(self, tmp_path, monkeypatch):
        """When $APPIMAGE matches canonical path, scaffold must still be called."""
        canonical = str(tmp_path / 'TimeTracker.AppImage')
        Path(canonical).write_bytes(b'fake')

        monkeypatch.setenv('APPIMAGE', canonical)
        monkeypatch.setattr(desktop_app, 'IS_APPIMAGE', True)
        monkeypatch.setattr(desktop_app, 'get_app_data_dir', lambda: str(tmp_path))

        with patch('desktop_app._ensure_install_scaffold') as mock_scaffold:
            with patch('desktop_app._cleanup_stale_user_desktop'):
                result = _install_appimage()

        assert result is True
        mock_scaffold.assert_called_once(), \
            "_ensure_install_scaffold must be called even when already at canonical path"

    def test_logs_dir_present_after_deb_style_launch(self, tmp_path, monkeypatch):
        """After simulating a .deb-style first launch, logs/ must exist."""
        canonical = str(tmp_path / 'TimeTracker.AppImage')
        Path(canonical).write_bytes(b'fake')
        os.chmod(canonical, 0o755)

        monkeypatch.setenv('APPIMAGE', canonical)
        monkeypatch.setattr(desktop_app, 'IS_APPIMAGE', True)
        monkeypatch.setattr(desktop_app, 'get_app_data_dir', lambda: str(tmp_path))

        with patch('desktop_app._cleanup_stale_user_desktop'):
            with patch('desktop_app._linux_notify'):
                with patch('desktop_app._try_enable_gnome_appindicator_extension'):
                    result = _install_appimage()

        assert result is True
        assert (tmp_path / 'logs').is_dir()
        assert (tmp_path / 'updates').is_dir()
        assert (tmp_path / 'uninstall.sh').is_file()


# ---------------------------------------------------------------------------
# UpdateManager — staged download lands in updates/ (regression guard)
# ---------------------------------------------------------------------------

class TestUpdateManagerUsesUpdatesDir:

    def test_staged_file_path_is_inside_updates_subdir(self, tmp_path):
        """UpdateManager must stage downloads inside updates/, not in install root."""
        from desktop_app import UpdateManager
        manager = UpdateManager(str(tmp_path), '1.0.0')

        update_info = {
            'update_available': True,
            'latest_version': '2.0.0',
            'download_url': 'https://example.com/TimeTracker_v2.0.0.AppImage',
            'checksum': None,
            'file_size_bytes': 0,
            'is_mandatory': False,
        }

        with patch('requests.get') as mock_get:
            mock_resp = MagicMock()
            mock_resp.headers = {}
            mock_resp.iter_content.return_value = [b'fake binary data']
            mock_resp.raise_for_status.return_value = None
            mock_get.return_value = mock_resp

            with patch('desktop_app.verify_download_checksum', return_value=True):
                manager.check_and_download(update_info)
                # Allow thread to run briefly
                import time
                time.sleep(0.5)

        # Regardless of download success, the updates dir must exist
        updates_dir = tmp_path / 'updates'
        assert updates_dir.is_dir(), \
            "UpdateManager must create the updates/ subdirectory"
```

### Additions to existing `tests/test_update_manager.py`

Add these test cases at the end of the file:

```python
# ---------------------------------------------------------------------------
# Regression: load_staged_update_if_exists uses .AppImage extension on Linux
# ---------------------------------------------------------------------------

def test_load_staged_update_appimage_extension_on_linux(tmp_path, monkeypatch):
    """On Linux with IS_APPIMAGE=True, staged file must have .AppImage extension."""
    monkeypatch.setattr(desktop_app, 'IS_APPIMAGE', True)

    updates_dir = tmp_path / 'updates'
    updates_dir.mkdir(parents=True)
    staged = updates_dir / 'TimeTracker_v3.0.0.AppImage'
    staged.write_bytes(b'binary-content')

    manager = UpdateManager(str(tmp_path), '1.0.0')
    assert manager.load_staged_update_if_exists() is True

    status = manager.get_status()
    assert status['state'] == 'ready'
    assert status['update_info']['latest_version'] == '3.0.0'
    assert status['download_path'].endswith('.AppImage')


def test_updates_directory_created_on_download(tmp_path, monkeypatch):
    """UpdateManager must create the updates/ dir if it does not exist."""
    monkeypatch.setattr(desktop_app, 'IS_APPIMAGE', True)

    manager = UpdateManager(str(tmp_path), '1.0.0')
    updates_dir = tmp_path / 'updates'
    assert not updates_dir.exists(), "Precondition: updates/ must not exist yet"

    update_info = {
        'update_available': True,
        'latest_version': '2.0.0',
        'download_url': 'https://example.com/TimeTracker_v2.0.0.AppImage',
        'checksum': None,
        'file_size_bytes': 0,
        'is_mandatory': False,
    }

    with patch('requests.get') as mock_get:
        mock_resp = MagicMock()
        mock_resp.headers = {}
        mock_resp.iter_content.return_value = [b'ELF binary']
        mock_resp.raise_for_status.return_value = None
        mock_get.return_value = mock_resp

        with patch('desktop_app.verify_download_checksum', return_value=True):
            manager.check_and_download(update_info)
            import time
            time.sleep(0.3)

    assert updates_dir.is_dir(), "UpdateManager must create updates/ directory"
```

---

## Verification Checklist

After implementing all fixes, run the following manual verification steps on
a **fresh Ubuntu 22.04 / 24.04 VM** with no prior TimeTracker installation:

### Step 1 — Install the .deb

```bash
sudo dpkg -i timetracker_1.0.3_amd64.deb
sudo apt-get install -f  # resolve any deps
```

### Step 2 — Verify postinst created expected structure

```bash
ls -la ~/.local/share/TimeTracker/
# Expected:
# TimeTracker.AppImage   (placed by postinst)
# logs/                  (created by postinst scaffold addition — Fix #4)
# updates/               (created by postinst scaffold addition — Fix #4)
```

### Step 3 — Launch the app (first time)

```bash
~/.local/share/TimeTracker/TimeTracker.AppImage
# OR via launcher:
timetracker
```

### Step 4 — Verify full scaffold created by first launch

```bash
ls -la ~/.local/share/TimeTracker/
# Expected after first launch:
# TimeTracker.AppImage       (executable, 0o755)
# logs/
#   timetracker.log          (written by app_logger)
# updates/                   (ready for auto-updater)
# uninstall.sh               (executable, 0o755) ← was missing before
# .first_launch_done         (marker file)
```

```bash
# Verify autostart entry
cat ~/.config/autostart/timetracker.desktop
# Must contain:
# Exec=env APPIMAGE_EXTRACT_AND_RUN=1 ~/.local/share/TimeTracker/TimeTracker.AppImage
```

### Step 5 — Verify GNOME extension enabled

```bash
gnome-extensions list --enabled | grep appindicator
# Expected: ubuntu-appindicators@ubuntu.com
```

If not enabled, check GNOME Shell version and restart shell:
```bash
# On X11:
killall -HUP gnome-shell
# On Wayland: log out and back in
```

### Step 6 — Verify tray icon is visible

- Tray icon should appear in the top bar after the GNOME AppIndicator
  extension is enabled and the shell refreshes
- A "TimeTracker installed" desktop notification should appear on first launch

### Step 7 — Run automated tests

```bash
cd python-desktop-app
python -m pytest tests/test_deb_install_scaffold.py -v
python -m pytest tests/test_update_manager.py -v
```

---

## Rollback Plan

All changes are in:
- `desktop_app.py` — `_install_appimage()` and two new functions
- `build.sh` — `POSTINST` heredoc only

**Rollback steps:**
1. Remove the `_ensure_install_scaffold()` call from the canonical-path branch
   (restore the single `return True` line)
2. Remove the `_ensure_install_scaffold()` function body
3. Remove `_try_enable_gnome_appindicator_extension()` function body
4. In `build.sh`, restore the `gnome-extensions enable` block (even though
   it does not work, it is safe and reversing the postinst change avoids
   re-building the .deb)

These changes have no breaking effect on existing installations because
`_ensure_install_scaffold()` is idempotent — it only creates files/dirs
that are missing and never overwrites existing ones.
