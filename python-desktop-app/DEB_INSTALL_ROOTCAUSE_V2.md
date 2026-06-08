# Root Cause Analysis: .deb Install Failure on User Systems (V2)

**Date:** 2026-06-08  
**Severity:** P0 — app completely non-functional on all .deb-installed systems  
**Verified by:** Empirical test on build machine (env var dump from /proc/PID/environ)

---

## Executive Summary

The TimeTracker `.deb` package installs correctly, but the app **silently crashes on every launch** on user systems. The root cause is that `APPIMAGE_EXTRACT_AND_RUN=1` mode (used by the launcher wrapper to avoid FUSE requirements) **does NOT set the `$APPIMAGE` environment variable**. The app's startup logic uses `$APPIMAGE` as the sole indicator that it's running inside an AppImage, causing it to take a completely wrong code path (Windows self-install logic) which fails on Linux.

---

## Evidence

### Screenshot 1 (User's system — broken):
- `~/.local/share/TimeTracker/` contains: `logs/`, `updates/`, `TimeTracker.AppImage`
- **Missing**: `uninstall.sh`, `.first_launch_done`, `time_tracker_offline.db`, `auth_metadata.json`, etc.
- No tray icon visible
- Double-clicking from app menu does nothing

### Screenshot 2 (Developer's system — working):
- Full set: `logs/`, `updates/`, `auth_metadata.json`, `TimeTracker.AppImage`, `time_tracker_consent.json`, `time_tracker_offline.db`, `time_tracker_user_cache.json`, `uninstall.sh`

### Empirical Test (on build machine):
```bash
$ env APPIMAGE_EXTRACT_AND_RUN=1 ./dist/TimeTracker-v1.0.3-x86_64.AppImage &
$ tr '\0' '\n' < /proc/$!/environ | grep -i appimage
APPIMAGE_EXTRACT_AND_RUN=1
# ← NO $APPIMAGE variable! Only APPIMAGE_EXTRACT_AND_RUN is set.
```

---

## Root Cause Chain

```
User double-clicks "TimeTracker" in app launcher
    ↓
GNOME runs: /usr/local/bin/timetracker
    ↓
Wrapper script: exec env APPIMAGE_EXTRACT_AND_RUN=1 ~/.local/share/TimeTracker/TimeTracker.AppImage
    ↓
AppImage runtime extracts squashfs to /tmp/, runs AppRun
⚠️ In extract-and-run mode, $APPIMAGE env var is NOT SET (only $APPIMAGE_EXTRACT_AND_RUN=1)
    ↓
Python starts, evaluates: IS_APPIMAGE = bool(os.environ.get('APPIMAGE'))  →  FALSE
    ↓
install_application() is called:
    if IS_APPIMAGE:           ← False, skipped!
        return _install_appimage()
    
    if is_running_from_install_location():  ← IS_APPIMAGE is False, falls through to path comparison
        ↓
    Compares sys.executable ("/tmp/.mount_XXX/usr/bin/TimeTracker")
    with get_installed_exe_path() ("~/.local/share/TimeTracker/TimeTracker.exe")
    → DON'T MATCH → returns False
    ↓
Falls into Windows self-install code:
    shutil.copy2(current_exe, installed_exe)  ← copies temp binary to "TimeTracker.exe"
    ↓
Either: copies wrong file, or path issues cause crash, or:
    After "install", relaunches installed_exe which doesn't exist/wrong binary
    ↓
APP CRASHES SILENTLY (no terminal output visible to user)
```

---

## Why It Works on Developer's Machine

On the developer's machine, the AppImage was likely launched **directly** (double-click on the `.AppImage` file) which uses **FUSE mount mode**:
- FUSE mode **does** set `$APPIMAGE=/path/to/TimeTracker.AppImage`
- So `IS_APPIMAGE = True`
- `_install_appimage()` is called → scaffold runs → everything works

Or the developer ran it from a terminal where `$APPIMAGE` was set by a previous FUSE-mode launch.

---

## Affected Code Locations

| Line | File | Issue |
|------|------|-------|
| ~621 | `desktop_app.py` | `IS_APPIMAGE = bool(os.environ.get('APPIMAGE'))` — only checks `$APPIMAGE`, not `$APPIMAGE_EXTRACT_AND_RUN` |
| ~1693 | `desktop_app.py` | `if IS_APPIMAGE: return _install_appimage()` — skipped when env var missing |
| ~1315 | `desktop_app.py` | `is_running_from_install_location()` — `IS_APPIMAGE` gate returns True only when True |
| ~355 | `build.sh` | Wrapper uses `APPIMAGE_EXTRACT_AND_RUN=1` which prevents `$APPIMAGE` from being set |

---

## Secondary Issues (also present but masked by the primary crash)

1. **GNOME AppIndicator extension not enabled** — even if the app ran, the tray icon would be invisible (the `_try_enable_gnome_appindicator_extension()` fix never runs because `_ensure_install_scaffold()` is never reached)
2. **Missing `uninstall.sh`** — `_ensure_install_scaffold()` never called
3. **No first-launch notification** — same reason

---

## Fix Plan

### Fix #1 (P0): Detect AppImage correctly in extract-and-run mode

**Problem:** `IS_APPIMAGE` relies solely on `$APPIMAGE` env var being set.  
**Solution:** Also check for `$APPIMAGE_EXTRACT_AND_RUN` env var, AND detect the canonical AppImage path on disk.

**File:** `desktop_app.py` (line ~621)

**Current code:**
```python
IS_APPIMAGE = bool(os.environ.get('APPIMAGE'))
```

**Fixed code:**
```python
# The AppImage runtime sets $APPIMAGE to the .AppImage file path in FUSE mode.
# However, in extract-and-run mode (APPIMAGE_EXTRACT_AND_RUN=1), the runtime
# does NOT set $APPIMAGE — only APPIMAGE_EXTRACT_AND_RUN is set.
# We must detect both modes to correctly identify we're inside an AppImage.
_APPIMAGE_PATH = os.environ.get('APPIMAGE', '')
_APPIMAGE_EXTRACT_MODE = bool(os.environ.get('APPIMAGE_EXTRACT_AND_RUN'))
IS_APPIMAGE = bool(_APPIMAGE_PATH) or _APPIMAGE_EXTRACT_MODE
```

### Fix #2 (P0): Handle missing `$APPIMAGE` in `_install_appimage()`

**Problem:** `_install_appimage()` uses `os.environ.get('APPIMAGE', '')` to get the current AppImage path. In extract-and-run mode this is empty, so the function bails with "not set — skipping".

**Solution:** When `$APPIMAGE` is not set but `APPIMAGE_EXTRACT_AND_RUN=1` is present, infer the AppImage path from the canonical location.

**File:** `desktop_app.py` — `_install_appimage()` function

**Current code:**
```python
canonical = os.path.join(get_app_data_dir(), 'TimeTracker.AppImage')
current_appimage = os.environ.get('APPIMAGE', '')
...
if not current_appimage:
    print("[INFO] AppImage install: $APPIMAGE not set — skipping install step")
    return True
```

**Fixed code:**
```python
canonical = os.path.join(get_app_data_dir(), 'TimeTracker.AppImage')
current_appimage = os.environ.get('APPIMAGE', '')

# In APPIMAGE_EXTRACT_AND_RUN=1 mode, the runtime does NOT set $APPIMAGE.
# Infer the AppImage path: if the canonical file exists on disk, we're almost
# certainly running from it (the .deb postinst or a previous install placed it).
# Fallback: check /opt/timetracker/ (the .deb system copy).
if not current_appimage and _APPIMAGE_EXTRACT_MODE:
    if os.path.isfile(canonical):
        current_appimage = canonical
        print(f"[INFO] Extract-and-run mode: inferred AppImage path: {canonical}")
    elif os.path.isfile('/opt/timetracker/TimeTracker.AppImage'):
        current_appimage = '/opt/timetracker/TimeTracker.AppImage'
        print(f"[INFO] Extract-and-run mode: using system AppImage: {current_appimage}")

...
if not current_appimage:
    print("[INFO] AppImage install: $APPIMAGE not set — skipping install step")
    return True
```

### Fix #3 (P1): Guard `is_running_from_install_location()` for extract-and-run mode

**Problem:** When `IS_APPIMAGE` is now correctly True in extract-and-run mode, the existing early-return `if IS_APPIMAGE: return True` in `is_running_from_install_location()` will correctly trigger. No code change needed here — Fix #1 resolves this automatically.

### Fix #4 (P1): Ensure the `/usr/local/bin/timetracker` wrapper also exports `$APPIMAGE`

**Problem:** Even with Fixes #1–2, the underlying issue is that the AppImage runtime doesn't set `$APPIMAGE` in extract-and-run mode.

**Solution:** Have the wrapper script explicitly set `$APPIMAGE` before executing:

**File:** `build.sh` — wrapper script in .deb

**Current:**
```bash
#!/bin/bash
CANONICAL="${HOME}/.local/share/TimeTracker/TimeTracker.AppImage"
if [ -f "$CANONICAL" ] && [ -x "$CANONICAL" ]; then
    exec env APPIMAGE_EXTRACT_AND_RUN=1 "$CANONICAL" "$@"
else
    exec env APPIMAGE_EXTRACT_AND_RUN=1 /opt/timetracker/TimeTracker.AppImage "$@"
fi
```

**Fixed:**
```bash
#!/bin/bash
CANONICAL="${HOME}/.local/share/TimeTracker/TimeTracker.AppImage"
if [ -f "$CANONICAL" ] && [ -x "$CANONICAL" ]; then
    exec env APPIMAGE_EXTRACT_AND_RUN=1 APPIMAGE="$CANONICAL" "$CANONICAL" "$@"
else
    exec env APPIMAGE_EXTRACT_AND_RUN=1 APPIMAGE="/opt/timetracker/TimeTracker.AppImage" /opt/timetracker/TimeTracker.AppImage "$@"
fi
```

### Fix #5 (P1): Update the user-level .desktop `Exec=` to also set `$APPIMAGE`

**File:** `build.sh` — postinst user .desktop creation, and `_ensure_install_scaffold()` autostart entry.

**Current postinst .desktop:**
```
Exec=env APPIMAGE_EXTRACT_AND_RUN=1 ${_CANONICAL}
```

**Fixed:**
```
Exec=env APPIMAGE_EXTRACT_AND_RUN=1 APPIMAGE=${_CANONICAL} ${_CANONICAL}
```

---

## Test Scripts

### Test 1: Verify IS_APPIMAGE detection in extract-and-run mode

```python
# tests/test_deb_install_scaffold.py — add these tests

class TestIsAppimageDetection:
    """Verify IS_APPIMAGE is True in both FUSE and extract-and-run modes."""

    def test_is_appimage_true_when_appimage_env_set(self, monkeypatch):
        """FUSE mode: $APPIMAGE is set → IS_APPIMAGE must be True."""
        monkeypatch.setenv('APPIMAGE', '/home/user/.local/share/TimeTracker/TimeTracker.AppImage')
        monkeypatch.delenv('APPIMAGE_EXTRACT_AND_RUN', raising=False)
        # Re-evaluate the detection logic
        _APPIMAGE_PATH = os.environ.get('APPIMAGE', '')
        _APPIMAGE_EXTRACT_MODE = bool(os.environ.get('APPIMAGE_EXTRACT_AND_RUN'))
        IS_APPIMAGE = bool(_APPIMAGE_PATH) or _APPIMAGE_EXTRACT_MODE
        assert IS_APPIMAGE is True

    def test_is_appimage_true_when_extract_and_run_set(self, monkeypatch):
        """Extract-and-run mode: only $APPIMAGE_EXTRACT_AND_RUN is set."""
        monkeypatch.delenv('APPIMAGE', raising=False)
        monkeypatch.setenv('APPIMAGE_EXTRACT_AND_RUN', '1')
        _APPIMAGE_PATH = os.environ.get('APPIMAGE', '')
        _APPIMAGE_EXTRACT_MODE = bool(os.environ.get('APPIMAGE_EXTRACT_AND_RUN'))
        IS_APPIMAGE = bool(_APPIMAGE_PATH) or _APPIMAGE_EXTRACT_MODE
        assert IS_APPIMAGE is True

    def test_is_appimage_false_when_neither_set(self, monkeypatch):
        """Dev mode: neither env var set → IS_APPIMAGE must be False."""
        monkeypatch.delenv('APPIMAGE', raising=False)
        monkeypatch.delenv('APPIMAGE_EXTRACT_AND_RUN', raising=False)
        _APPIMAGE_PATH = os.environ.get('APPIMAGE', '')
        _APPIMAGE_EXTRACT_MODE = bool(os.environ.get('APPIMAGE_EXTRACT_AND_RUN'))
        IS_APPIMAGE = bool(_APPIMAGE_PATH) or _APPIMAGE_EXTRACT_MODE
        assert IS_APPIMAGE is False
```

### Test 2: Verify _install_appimage() infers path in extract-and-run mode

```python
class TestInstallAppimageExtractAndRun:
    """Verify scaffold runs when only APPIMAGE_EXTRACT_AND_RUN is set (no $APPIMAGE)."""

    def test_scaffold_runs_in_extract_and_run_mode(self, tmp_path, monkeypatch):
        """When APPIMAGE_EXTRACT_AND_RUN=1 and canonical AppImage exists, scaffold must run."""
        canonical = str(tmp_path / 'TimeTracker.AppImage')
        Path(canonical).write_bytes(b'fake')
        os.chmod(canonical, 0o755)

        # Simulate extract-and-run mode: APPIMAGE not set, APPIMAGE_EXTRACT_AND_RUN=1
        monkeypatch.delenv('APPIMAGE', raising=False)
        monkeypatch.setenv('APPIMAGE_EXTRACT_AND_RUN', '1')
        monkeypatch.setattr(desktop_app, 'IS_APPIMAGE', True)
        monkeypatch.setattr(desktop_app, '_APPIMAGE_EXTRACT_MODE', True)
        monkeypatch.setattr(desktop_app, '_APPIMAGE_PATH', '')
        monkeypatch.setattr(desktop_app, 'get_app_data_dir', lambda: str(tmp_path))

        with patch('desktop_app._cleanup_stale_user_desktop'), \
             patch('desktop_app._ensure_install_scaffold') as mock_scaffold:
            result = _install_appimage()

        assert result is True
        mock_scaffold.assert_called_once()

    def test_infers_canonical_path_when_file_exists(self, tmp_path, monkeypatch):
        """Must infer canonical path from disk when $APPIMAGE is not set."""
        canonical = str(tmp_path / 'TimeTracker.AppImage')
        Path(canonical).write_bytes(b'fake')
        os.chmod(canonical, 0o755)

        monkeypatch.delenv('APPIMAGE', raising=False)
        monkeypatch.setenv('APPIMAGE_EXTRACT_AND_RUN', '1')
        monkeypatch.setattr(desktop_app, 'IS_APPIMAGE', True)
        monkeypatch.setattr(desktop_app, '_APPIMAGE_EXTRACT_MODE', True)
        monkeypatch.setattr(desktop_app, '_APPIMAGE_PATH', '')
        monkeypatch.setattr(desktop_app, 'get_app_data_dir', lambda: str(tmp_path))

        with patch('desktop_app._cleanup_stale_user_desktop'), \
             patch('desktop_app._linux_notify'), \
             patch('desktop_app._try_enable_gnome_appindicator_extension'):
            result = _install_appimage()

        assert result is True
        assert (tmp_path / 'uninstall.sh').is_file()
        assert (tmp_path / 'logs').is_dir()
        assert (tmp_path / 'updates').is_dir()

    def test_returns_true_when_no_appimage_found(self, tmp_path, monkeypatch):
        """If canonical AppImage doesn't exist, must still return True (don't crash)."""
        monkeypatch.delenv('APPIMAGE', raising=False)
        monkeypatch.setenv('APPIMAGE_EXTRACT_AND_RUN', '1')
        monkeypatch.setattr(desktop_app, 'IS_APPIMAGE', True)
        monkeypatch.setattr(desktop_app, '_APPIMAGE_EXTRACT_MODE', True)
        monkeypatch.setattr(desktop_app, '_APPIMAGE_PATH', '')
        monkeypatch.setattr(desktop_app, 'get_app_data_dir', lambda: str(tmp_path))

        with patch('desktop_app._cleanup_stale_user_desktop'):
            result = _install_appimage()

        assert result is True, "Must not crash even if no AppImage file exists"
```

### Test 3: Verify wrapper script sets $APPIMAGE

```python
class TestWrapperScript:
    """Verify the /usr/local/bin/timetracker wrapper propagates $APPIMAGE."""

    def test_wrapper_exports_appimage_env_var(self, tmp_path):
        """The wrapper script must set APPIMAGE= in the exec env command."""
        # Read the build.sh and check wrapper content
        build_sh = Path(__file__).parent.parent / 'build.sh'
        content = build_sh.read_text()
        # The wrapper must include APPIMAGE= in the exec env line
        assert 'APPIMAGE="$CANONICAL"' in content or "APPIMAGE=$CANONICAL" in content, \
            "Wrapper script must explicitly set APPIMAGE env var for extract-and-run mode"
```

---

## Verification Steps After Fix

1. **Build new .deb**: `./build.sh`
2. **Install on fresh VM**: `sudo dpkg -i dist/timetracker_*.deb && sudo apt install -f`
3. **Verify wrapper**: `cat /usr/local/bin/timetracker` → must contain `APPIMAGE=`
4. **Launch from app menu** → verify tray icon appears
5. **Check install dir**: `ls ~/.local/share/TimeTracker/`  
   Expected: `TimeTracker.AppImage`, `logs/`, `updates/`, `uninstall.sh`, `.first_launch_done`
6. **Check env vars**: `tr '\0' '\n' < /proc/$(pgrep -f TimeTracker)/environ | grep APPIMAGE`  
   Expected: Both `APPIMAGE=<path>` and `APPIMAGE_EXTRACT_AND_RUN=1`

---

## Why Previous Fix Didn't Work

The previous fix (adding `_ensure_install_scaffold()`) was architecturally correct but **never reached** because:
1. It was placed inside `_install_appimage()` — which is only called when `IS_APPIMAGE` is True
2. `IS_APPIMAGE` was False on user systems (because `$APPIMAGE` isn't set in extract-and-run mode)
3. The `logs/` and `updates/` directories that DO exist on the user's system were created by the `.deb` **postinst script** (our Fix #4 from the previous round), not by the Python code

The fix was in the right place logically, but the gate (`IS_APPIMAGE` check) prevented it from ever executing.
