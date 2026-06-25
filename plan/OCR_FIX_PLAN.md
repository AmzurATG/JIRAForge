# TimeTracker OCR Fix Plan — Yogi's System

**Date:** 2026-06-20  
**OS:** Ubuntu Linux (Wayland session, `wayland-0`)  
**App:** TimeTracker v1.0.2 (AppImage)  
**Symptom:** OCR / screen content capture not working; running in metadata-only mode

---

## Problem Statement

TimeTracker is running in **METADATA-ONLY mode** — it tracks window titles but cannot capture screen content for OCR. The root cause is a multi-layer failure involving AppImage isolation, missing GStreamer plugin bundling, and a Wayland-specific capture pipeline requirement.

---

## Root Cause Analysis

### Layer 1 (Primary) — AppImage Does Not Bundle `pipewiresrc`

The app is distributed as an AppImage:
```
Executable: /tmp/.mount_TimeTraUf6jY/usr/bin/TimeTracker
```

AppImages are self-contained. They ship their own GStreamer runtime and plugin directory. The system check that fails:
```
WARNING - system_check - GStreamer pipewiresrc plugin not available
```
...is checking inside the AppImage's own plugin path, **not** the system's. Installing `gstreamer1.0-pipewire` via `apt` on the host has zero effect because:

```
# What apt installs (host):
/usr/lib/x86_64-linux-gnu/gstreamer-1.0/libgstpipewire.so  ✓

# What the AppImage sees (its own bundle):
/tmp/.mount_TimeTraUf6jY/usr/lib/gstreamer-1.0/libgstpipewire.so  ✗ MISSING
```

**This is the core bug — the AppImage was built without bundling the PipeWire GStreamer plugin.**

---

### Layer 2 (Secondary) — OAuth Failure Prevents Full Initialization

The app fails OAuth token refresh at startup:
```
[ERROR] Token refresh failed: Refresh token expired, revoked, or rotated out.
[WARN] Server confirmed refresh token permanently invalid (OAUTH_REAUTH_REQUIRED)
```
This causes the app to skip or short-circuit parts of its initialization sequence, including the `xdg-desktop-portal` permission prompt that must appear for Wayland screen capture. The user never sees the grant dialog.

---

### Layer 3 (Tertiary) — Wrong pystray Backend on Wayland

The tray icon uses the `_xorg` backend despite running on Wayland:
```
[WARN] Running on pystray backend '_xorg' without menu support.
```
This backend uses XWayland (`DISPLAY=':0'`). Even if screenshots were taken via this path, they would only capture **XWayland windows** — native Wayland apps (browser, file manager, terminals) would appear as black rectangles, making OCR results useless.

The consequence is also 26+ minutes of flooding error logs every 2 seconds:
```
ERROR - pystray._base - Failed to dock icon (AssertionError in _assert_docked)
```

---

## Fix Plan

### Phase 1 — User-Side Workaround (Immediate)

These steps can be done by the user right now to unblock OCR without waiting for an app update.

#### Step 1.1 — Bridge System GStreamer Plugins into AppImage

Set the `GST_PLUGIN_PATH` environment variable to include the system's GStreamer plugin directory when launching the AppImage. This allows the AppImage's GStreamer to find `libgstpipewire.so` from the host system.

```bash
# Test first — run from terminal to confirm it works
GST_PLUGIN_PATH=/usr/lib/x86_64-linux-gnu/gstreamer-1.0 \
  /home/yamunay/.local/share/TimeTracker/TimeTracker.AppImage
```

If OCR starts working, make this permanent:

```bash
# Edit the autostart desktop entry
nano /home/yamunay/.config/autostart/TimeTracker.desktop
```

Change the `Exec=` line from:
```ini
Exec=/home/yamunay/.local/share/TimeTracker/TimeTracker.AppImage
```
To:
```ini
Exec=env GST_PLUGIN_PATH=/usr/lib/x86_64-linux-gnu/gstreamer-1.0 /home/yamunay/.local/share/TimeTracker/TimeTracker.AppImage
```

#### Step 1.2 — Verify System Packages Are Installed

```bash
# Confirm the packages are actually installed (not just attempted)
dpkg -l | grep -E "gstreamer1.0-pipewire|gstreamer1.0-plugins-good|gstreamer1.0-plugins-base|gstreamer1.0-tools"

# If any are missing, install:
sudo apt install -y gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
  gstreamer1.0-tools gstreamer1.0-pipewire
```

#### Step 1.3 — Verify PipeWire Portal is Running

```bash
# All three must be active
systemctl --user status xdg-desktop-portal
systemctl --user status xdg-desktop-portal-gnome
systemctl --user status pipewire
systemctl --user status wireplumber

# If any are inactive, restart them:
systemctl --user restart pipewire pipewire-pulse wireplumber xdg-desktop-portal xdg-desktop-portal-gnome
```

#### Step 1.4 — Re-authenticate First (Critical)

The OAuth failure at startup may be preventing the portal permission dialog from ever appearing. Re-authenticate before testing OCR:

1. Open browser to `http://localhost:51777/login`
2. Complete the Atlassian OAuth flow
3. Close and relaunch TimeTracker with the `GST_PLUGIN_PATH` fix from Step 1.1
4. Watch for a GNOME system dialog asking to grant screen recording permission — **click Allow**

---

### Phase 2 — App-Level Fix (Developer Action Required)

These require changes to how the AppImage is built. Raise these with the TimeTracker development team.

#### Fix 2.1 — Bundle `libgstpipewire.so` in the AppImage

The AppImage build script (likely using `linuxdeploy` or `appimagetool`) must be updated to include the PipeWire GStreamer plugin.

**In the build pipeline, add:**
```bash
# Copy the pipewire plugin into the AppDir before packaging
APPDIR=./AppDir
GSTREAMER_PLUGIN_DIR="$APPDIR/usr/lib/gstreamer-1.0"
mkdir -p "$GSTREAMER_PLUGIN_DIR"

cp /usr/lib/x86_64-linux-gnu/gstreamer-1.0/libgstpipewire.so \
   "$GSTREAMER_PLUGIN_DIR/"

# Also copy the pipewire client library it depends on
cp /usr/lib/x86_64-linux-gnu/libpipewire-0.3.so* \
   "$APPDIR/usr/lib/"
```

Or if using `linuxdeploy`:
```bash
linuxdeploy --appdir AppDir \
  --plugin gstreamer \
  --executable /usr/bin/TimeTracker \
  --output appimage
```
And ensure `GST_PLUGIN_SCANNER` and `GST_PLUGIN_PATH` are set correctly in the AppRun wrapper script.

#### Fix 2.2 — Replace `pystray._xorg` with AppIndicator on Wayland

The system tray backend selection logic must prefer `AppIndicator` or `AyatanaAppIndicator` when a Wayland session is detected, rather than falling back to `_xorg`.

```python
# Current behavior (broken):
# Falls through to _xorg backend on Wayland

# Required behavior:
import os
session_type = os.environ.get('XDG_SESSION_TYPE', '').lower()
if session_type == 'wayland':
    # Use AppIndicator/Ayatana backend
    # Requires: gir1.2-ayatanaappindicator3-0.1
    use_appindicator_backend()
else:
    use_xorg_backend()
```

Also ensure this package is installed as a dependency for Linux distributions:
```
gir1.2-ayatanaappindicator3-0.1
```

#### Fix 2.3 — Suppress Repetitive `_assert_docked` Error Logging

Until Fix 2.2 is implemented, the `_assert_docked` failure should be caught and logged at most once (not every 2 seconds indefinitely):

```python
# Wrap the pystray icon run loop with a docking failure counter
# Log the first failure, suppress subsequent identical errors
```

#### Fix 2.4 — Decouple OAuth from Capture Pipeline Init

The screen capture initialization should not depend on OAuth success. These are independent subsystems. The portal permission prompt must appear regardless of authentication state, as it is a system-level permission.

---

### Phase 3 — Verification Checklist

After applying fixes, verify all items pass:

- [ ] `GST_PLUGIN_PATH` launch test shows no `pipewiresrc plugin not available` warning
- [ ] GNOME portal permission dialog appears on first launch
- [ ] After granting permission, screenshots are visible in the app UI
- [ ] OCR text extraction produces results (check app logs for OCR output lines)
- [ ] System tray icon appears without `_assert_docked` errors
- [ ] Tray right-click menu is functional on Wayland
- [ ] Reboot persistence: autostart with `GST_PLUGIN_PATH` set correctly

---

## Summary

| Priority | Action | Owner | Effort |
|---|---|---|---|
| P0 | Re-authenticate OAuth | User | 2 min |
| P0 | Test `GST_PLUGIN_PATH` launch workaround | User | 5 min |
| P0 | Make `GST_PLUGIN_PATH` permanent in autostart | User | 5 min |
| P1 | Bundle `libgstpipewire.so` in AppImage build | Developer | Medium |
| P1 | Fix `pystray` backend selection for Wayland | Developer | Medium |
| P2 | Decouple OAuth from capture pipeline init | Developer | Medium |
| P2 | Suppress repetitive `_assert_docked` log spam | Developer | Low |

---

## Environment Reference

| Property | Value |
|---|---|
| App Version | v1.0.2 |
| OS | Ubuntu Linux |
| Session | Wayland (`wayland-0`) |
| Display | `:0` (XWayland also active) |
| Python | 3.12.3 |
| App Path | `/home/yamunay/.local/share/TimeTracker/TimeTracker.AppImage` |
| DB Path | `/home/yamunay/.local/share/TimeTracker/time_tracker_offline.db` |
| Log Path | `/home/yamunay/.local/share/TimeTracker/logs/timetracker.log` |
| Flask Port | `51777` |
