# Plan for timetracker_yogi.log Error Fixes

## Log Analysis
Upon reviewing `/home/iswaryak/ATG/new-main-linux/JIRAForge/plan/timetracker_yogi.log`, three main categories of "errors" were identified:

1. **GStreamer pipewiresrc plugin not available**
   - **Context:** The system lacks the required `gstreamer1.0-pipewire` package.
   - **Resolution:** This is already handled as a graceful degradation. The application correctly falls back to metadata-only mode and logs a user-friendly message with the exact command (`sudo apt install -y ...`) to fix it. *Status: By Design / Handled.*

2. **Token Refresh Failure**
   - **Context:** `[ERROR] Token refresh failed: Refresh token expired, revoked, or rotated out. User must re-authenticate.`
   - **Resolution:** This indicates a permanently invalid refresh token (likely revoked or rotated out by the server). The application properly traps this, prevents an infinite loop, and prompts the user to re-authenticate via the UI. *Status: By Design / Handled.*

3. **Continuous `Failed to dock icon` Spam**
   - **Context:** The log is spammed every 2 seconds with a `pystray._base - Failed to dock icon` error and a traceback originating from `pystray/_xorg.py` (`_assert_docked`).
   - **Root Cause:** The `update_icon_periodically` daemon thread runs every 2 seconds to check status and refresh the tray icon. If the X11/Wayland system tray drops the icon (or if it doesn't support docking and the icon is destroyed), `pystray` logs an internal error whenever `icon.icon = ...` is called. Furthermore, the daemon thread was directly calling `self.update_tray_icon()` instead of the Linux thread-safe `self._safe_update_tray_icon()`.
   - **Resolution Needed:** 
     1. Change the direct `self.update_tray_icon()` call to `self._safe_update_tray_icon()` within `update_icon_periodically()` to ensure thread safety on GTK/GLib.
     2. Add a logging filter to the `pystray._base` logger to explicitly suppress the "Failed to dock icon" assertion error spam, as it doesn't break background tracking functionality but clutters the logs massively.

## Implementation Details
- Edited `/home/iswaryak/ATG/new-main-linux/JIRAForge/python-desktop-app/desktop_app.py`
- In `setup_system_tray`:
  - Added a `_PystrayNoDockFilter` class to suppress "Failed to dock icon" in the `pystray._base` logger.
  - Updated `update_icon_periodically` to use `self._safe_update_tray_icon()`.

## Status
- All fixes have been applied.
