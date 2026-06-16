# Screencast Dependency Self-Healing Plan
## In-App Detection, Notification & Guided Repair for Missing System Packages
**Date**: 2026-06-16
**Status**: Planning
**Priority**: High — affects all Wayland users with fresh OS installs

---

## 1. Problem Statement

When TimeTracker starts on a Linux Wayland system that is missing PipeWire/GStreamer/XDG-portal packages, it silently falls back to **metadata-only mode** (no OCR, no screen capture). The user receives no actionable UI feedback — only a STDERR dump that is invisible to end-users running the AppImage from a desktop launcher.

### Evidence from logs (2026-06-12 — user yamunay / AMZ-LAP-344)
| Time | Event |
|------|-------|
| 14:47:56 | `[MAIN] Screenshot monitoring: DISABLED` |
| 14:47:56 | `WARNING system_check — GStreamer pipewiresrc plugin not available` |
| 14:47:56 | `ERROR STDERR — SCREENSHOT CAPTURE DEPENDENCIES MISSING` |
| 14:47:56 | `[TRACKER] Screenshot capture will not work — running in metadata-only mode` |
| 14:48:28 | `All OCR engines failed. rapidocr: Confidence too low (0.00 < 0.6 threshold)` |
| 14:48:xx–14:55:xx | `[WinDetect] ALL METHODS FAILED` — repeated every 2 s |

The failure is silent to the user, yet total: no window detection, no OCR, no screenshots.

---

## 2. Root Causes

### 2.1 Missing GStreamer PipeWire plugin (primary)
`system_check.py → check_gstreamer_plugin('pipewiresrc')` fails → `gstreamer1.0-pipewire` apt package not installed.

### 2.2 ScreenCast Portal unavailable (secondary)
`check_screencast_portal()` fails → `xdg-desktop-portal-gnome` (or `-gtk`) not installed or portal daemon not running.

### 2.3 No user-visible notification
The app writes to STDERR and logs only. On a desktop-launched AppImage there is no terminal. `_linux_notify()` (already available in `desktop_app.py:687`) is **never called** for this failure path.

### 2.4 Distro-agnostic install command not generated
`get_installation_instructions()` in `system_check.py` hard-codes `apt install` — fails silently on Fedora, Arch, openSUSE.

### 2.5 No retry / re-check path
Once fallback mode is set, no mechanism re-checks whether the user has since installed packages and restarted services.

---

## 3. Scope of Changes

| File | Role |
|------|------|
| `python-desktop-app/system_check.py` | Core detection + distro-aware install command generation |
| `python-desktop-app/desktop_app.py` | Startup notification, tray menu badge, web UI route |
| `python-desktop-app/ocr/` | No change needed (already degrades gracefully) |
| `scripts/fix-screenshot-capture.sh` | Kept as internal/support-only tool; not surfaced to users |

---

## 4. Detailed Implementation Plan

---

### Phase 1 — Distro-Aware Install Command Generator (`system_check.py`)

**Goal**: Replace the hard-coded `apt install` string with a function that reads `/etc/os-release` and outputs the correct package manager command for the user's actual distro.

#### 4.1.1 Add `detect_distro()` function

```python
def detect_distro() -> dict:
    """
    Parse /etc/os-release to identify distro family.
    Returns: {'id': 'ubuntu', 'id_like': 'debian', 'pkg_manager': 'apt'}
    """
```

Supported families and their mappings:

| `ID` / `ID_LIKE` value | Package manager | Install verb |
|------------------------|-----------------|--------------|
| `ubuntu`, `debian`, `linuxmint`, `pop` | `apt` | `sudo apt install -y` |
| `fedora`, `rhel`, `centos`, `rocky`, `alma` | `dnf` | `sudo dnf install -y` |
| `opensuse`, `sles` | `zypper` | `sudo zypper install -y` |
| `arch`, `manjaro`, `endeavouros` | `pacman` | `sudo pacman -S --noconfirm` |
| fallback | `apt` | `sudo apt install -y` |

#### 4.1.2 Add `get_distro_packages()` function

Maps missing components to distro-specific package names:

| Logical component | apt | dnf | zypper | pacman |
|-------------------|-----|-----|--------|--------|
| pipewire | `pipewire wireplumber` | `pipewire wireplumber` | `pipewire wireplumber` | `pipewire wireplumber` |
| gstreamer-pipewire | `gstreamer1.0-pipewire` | `gstreamer1-plugin-pipewire` | `gstreamer-plugin-pipewire` | `gst-plugin-pipewire` |
| gstreamer-base | `gstreamer1.0-plugins-base gstreamer1.0-plugins-good` | `gstreamer1-plugins-base gstreamer1-plugins-good` | `gstreamer-plugins-base gstreamer-plugins-good` | `gst-plugins-base gst-plugins-good` |
| xdg-portal | `xdg-desktop-portal` | `xdg-desktop-portal` | `xdg-desktop-portal` | `xdg-desktop-portal` |
| xdg-portal-backend | `xdg-desktop-portal-gnome` | `xdg-desktop-portal-gnome` | `xdg-desktop-portal-gnome` | `xdg-desktop-portal-gnome` |

#### 4.1.3 Refactor `get_installation_instructions()` to:
1. Call `detect_distro()` → get package manager.
2. Call `get_distro_packages()` → get per-component package list filtered to only **missing** components.
3. Emit a single runnable install command (one copy-paste line).
4. Emit the correct systemctl restart command.
5. Return both a `str` (for STDERR / logs) and a `dict` (for web UI / notification).

#### 4.1.4 Add `recheck()` public method to `SystemDependencyChecker`
Called by the web UI `/api/system/screencast-check` endpoint (Phase 3). Runs `check_all()` again at runtime and returns fresh results — allows repair-then-recheck without restarting the app.

---

### Phase 2 — User-Visible Notifications (`desktop_app.py`)

**Goal**: Make the missing-dependency state clearly visible to the user immediately on startup via desktop notification and tray menu.

#### 4.2.1 Desktop notification on startup (one-shot)

In `TimeTracker.__init__()`, after `check_dependencies_startup()` returns `False`:

```python
if not deps_ok and sys.platform.startswith('linux'):
    _linux_notify(
        "Screen Capture Unavailable",
        "Missing system packages. Click tray icon → 'Fix Screen Capture' for instructions.",
        urgency="critical"
    )
```

This uses the existing `_linux_notify()` → `notify-send` path (line 687 of `desktop_app.py`).  
**Condition**: Only fire once per app launch (guard with a `_dep_notify_sent` flag).

#### 4.2.2 Tray menu badge for missing deps

In `_build_tray_menu()` (line 14457), add a pinned item at the top when `self.screenshot_dependencies_ok is False`:

```python
if not getattr(self, 'screenshot_dependencies_ok', True):
    menu_items.insert(0, item(
        '⚠ Screen capture unavailable — click to fix',
        self._open_screencast_fix_page
    ))
    menu_items.insert(1, pystray.Menu.SEPARATOR)
```

This is the most discoverable surface; the tray icon is always visible.

#### 4.2.3 Add `_open_screencast_fix_page()` handler

```python
def _open_screencast_fix_page(self, icon=None, item=None):
    """Open the in-app web repair page for missing screencast dependencies."""
    webbrowser.open(f'http://localhost:{self.web_port}/system/screencast-fix')
```

#### 4.2.4 Re-run tray menu build after successful repair

When the `/api/system/screencast-check` endpoint (Phase 3) detects all checks now pass, call `self.update_tray_menu()` to remove the warning item.

---

### Phase 3 — Web UI Repair Page (`desktop_app.py` → new Flask route)

**Goal**: Provide a guided, copy-paste-ready repair page accessible from the tray menu, requiring no terminal knowledge.

#### 4.3.1 New route: `GET /system/screencast-fix`

Renders an HTML page showing:
1. **Status panel** — per-component pass/fail table (PipeWire, GStreamer pipewiresrc, ScreenCast Portal).
2. **Distro-detected install command** — pre-selected, copy-button ready.
3. **Step-by-step guide** with numbered instructions.
4. **"Re-check now" button** — calls `/api/system/screencast-check` via fetch, refreshes status panel.

The page is rendered inline via `render_template_string` (matching the existing pattern in `desktop_app.py`), so no new template files are needed.

**Status table columns**: Component | Required | Detected | Status  
Example row: `GStreamer pipewiresrc | Yes | No | ❌ Missing`

#### 4.3.2 New route: `GET /api/system/screencast-check`

JSON endpoint that runs `SystemDependencyChecker().check_all()` live and returns:

```json
{
  "all_ok": false,
  "wayland": true,
  "pipewire": false,
  "gstreamer_pipewiresrc": false,
  "screencast_portal": false,
  "install_command": "sudo apt install -y pipewire wireplumber gstreamer1.0-pipewire gstreamer1.0-plugins-base gstreamer1.0-plugins-good xdg-desktop-portal xdg-desktop-portal-gnome",
  "restart_command": "systemctl --user restart pipewire pipewire-pulse wireplumber",
  "distro": "ubuntu"
}
```

Used by the "Re-check now" button in the repair page.

---

### Phase 4 — Graceful Tray State Sync

**Goal**: If the user fixes dependencies mid-session (installs packages, restarts services), the tray and internal state should update without requiring a full app restart.

#### 4.4.1 Background re-check on `/api/system/screencast-check` success

When the API endpoint detects `all_ok: true`:
1. Set `self.screenshot_dependencies_ok = True`.
2. Clear `self.missing_dependencies`.
3. Call `self.update_tray_menu()` to remove the warning item.
4. Log `[INFO] Screencast dependencies now satisfied — re-enabling capture`.

Note: Full OCR/capture re-initialisation still requires an app restart (the GStreamer `Gst.init()` call at module import cannot be re-run). The repair page should clearly state this.

---

## 5. File-Level Change Summary

### `python-desktop-app/system_check.py`

| Change | Lines affected (approx.) |
|--------|--------------------------|
| Add `detect_distro()` | New function ~30 lines |
| Add `get_distro_packages()` | New function ~50 lines |
| Refactor `get_installation_instructions()` to use above + return dict | Replaces lines 120–155 |
| Add `recheck()` method to `SystemDependencyChecker` | New method ~10 lines |

### `python-desktop-app/desktop_app.py`

| Change | Lines affected (approx.) |
|--------|--------------------------|
| Startup `_linux_notify()` call after dep check fails | After line 6705 |
| `_dep_notify_sent` guard flag | Near line 6697 (in `__init__`) |
| `_open_screencast_fix_page()` method | New method ~5 lines |
| Tray menu badge item (warning + separator) | After line 14486 in `_build_tray_menu()` |
| Flask route `GET /system/screencast-fix` | New route in `setup_routes()` after line 8028 |
| Flask route `GET /api/system/screencast-check` | New route in `setup_routes()` |

---

## 6. Non-Goals (explicitly excluded)

- **Automatic package installation**: We never auto-run `sudo apt install` on behalf of the user. Installation requires user consent and elevated privileges; we only generate and display the command.
- **Modifying `scripts/fix-screenshot-capture.sh`**: The script remains unchanged and internal/support-only.
- **Changing OCR fallback behaviour**: `ocr/facade.py` and related files stay unchanged.
- **Windows / macOS**: All changes are Linux-only, guarded by `sys.platform.startswith('linux')`.
- **Presidio/spacy install guidance**: Separate concern; not in scope here.

---

## 7. Testing Plan

### 7.1 Unit tests (new file: `tests/test_system_check_distro.py`)

| Test | Assertion |
|------|-----------|
| `test_detect_distro_ubuntu` | Mock `/etc/os-release` with `ID=ubuntu` → `pkg_manager == 'apt'` |
| `test_detect_distro_fedora` | Mock with `ID=fedora` → `pkg_manager == 'dnf'` |
| `test_detect_distro_arch` | Mock with `ID=arch` → `pkg_manager == 'pacman'` |
| `test_detect_distro_fallback` | Missing `/etc/os-release` → `pkg_manager == 'apt'` |
| `test_install_command_only_missing` | When only `gstreamer_pipewiresrc` fails → command contains only its package |
| `test_install_command_all_missing` | All 3 fail → command contains all packages |
| `test_recheck_all_pass` | Mock `check_all()` to return all True → `recheck()` returns `True` |

### 7.2 Integration test (manual, on AMZ-LAP-344 class machine)

1. Uninstall `gstreamer1.0-pipewire` to reproduce the original failure.
2. Launch TimeTracker → verify desktop notification appears.
3. Click tray icon → verify `⚠ Screen capture unavailable` item is present.
4. Click item → browser opens `/system/screencast-fix`.
5. Verify status table shows correct failures.
6. Verify install command is distro-correct (`apt` for Ubuntu).
7. Copy and run install command → restart PipeWire.
8. Click "Re-check now" → table refreshes, all green.
9. Verify tray menu no longer shows warning item.

### 7.3 Regression check

- Confirm that on a fully-provisioned machine (all deps present), none of the new UI elements appear.
- Confirm no STDOUT/STDERR regression on X11 sessions (`is_wayland == False`).

---

## 8. Acceptance Criteria

| # | Criteria |
|---|----------|
| AC-1 | On a Wayland machine missing `gstreamer1.0-pipewire`, a `notify-send` desktop notification appears within 5 s of launch |
| AC-2 | The system tray icon shows a warning menu item as the first entry |
| AC-3 | Clicking the warning item opens `http://localhost:<port>/system/screencast-fix` in the default browser |
| AC-4 | The repair page lists all three components (PipeWire, GStreamer pipewiresrc, ScreenCast Portal) with per-item status |
| AC-5 | The install command on Ubuntu 24.04 matches exactly the package list from `SCREENCAST_IMPLEMENTATION_PLAN.md` |
| AC-6 | The install command on Fedora uses `dnf` with Fedora-specific package names |
| AC-7 | After clicking "Re-check now" post-install, the page shows all-green and the tray warning disappears |
| AC-8 | On a fully-provisioned machine, zero new UI elements appear |
| AC-9 | On an X11 session, all new code paths short-circuit without side effects |

---

## 9. Implementation Order

```
Phase 1 — system_check.py changes (distro detection + refactor)
    ↓ (no runtime dependency)
Phase 2 — desktop_app.py: startup notification + tray badge
    ↓ (depends on Phase 1 for install command string)
Phase 3 — desktop_app.py: Flask routes for repair page
    ↓ (depends on Phase 1 for JSON payload + Phase 2 for _open_screencast_fix_page)
Phase 4 — tray state sync on re-check pass
    ↓ (depends on Phase 3 endpoint)
Tests
```

Total estimated implementation: ~2 developer-days.
