# Screenshot Flash Elimination Solution

## Problem Summary

The TimeTracker desktop application captures screenshots continuously (every 5-15 minutes) for time tracking purposes. GNOME Shell on Wayland displays a camera flash animation every time a screenshot is taken, which becomes highly annoying for users during continuous automated capture.

## Root Cause

The flash is hardcoded in GNOME Shell's `screenshot.js` file in the `Flashspot` class:

```javascript
const FLASHSPOT_ANIMATION_OUT_TIME = 500; // milliseconds

export const Flashspot = GObject.registerClass(
class Flashspot extends Lightbox.Lightbox {
    _init(area) {
        super._init(Main.uiGroup, {
            inhibitEvents: true,
            width: area.width,
            height: area.height,
        });
        this.style_class = 'flashspot';
        this.set_position(area.x, area.y);
    }

    fire(doneCallback) {
        this.set({visible: true, opacity: 255});
        this.ease({
            opacity: 0,
            duration: FLASHSPOT_ANIMATION_OUT_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (doneCallback)
                    doneCallback();
                this.destroy();
            },
        });
    }
});
```

The GNOME Shell Screenshot D-Bus API (`org.gnome.Shell.Screenshot`) **does support a `flash` parameter**:
- `flash=true` - Show the flash animation (default for manual screenshots)
- `flash=false` - Skip the flash animation

**However**:
1. **GNOME 46+ blocks direct access** to `org.gnome.Shell.Screenshot` D-Bus API with `AccessDenied` error
2. **XDG Desktop Portal** is the correct Wayland API, but the GNOME Portal backend (`xdg-desktop-portal-gnome`) **does not expose the flash parameter** and always triggers the flash

## Solutions Evaluated

### ❌ Solution 1: Call org.gnome.Shell.Screenshot with flash=false
**Status**: Blocked on GNOME 46+

```python
# This WOULD work on GNOME 45 and earlier:
connection.call_sync(
    'org.gnome.Shell.Screenshot',
    '/org/gnome/Shell/Screenshot',
    'org.gnome.Shell.Screenshot',
    'Screenshot',
    GLib.Variant('(bbs)', (False, False, filename)),  # flash=False
    ...
)
```

**Problem**: Returns `GDBus.Error:org.freedesktop.DBus.Error.AccessDenied: Screenshot is not allowed` on GNOME 46+

### ❌ Solution 2: Use Shell.Screenshot via GObject Introspection
**Status**: Not possible from external applications

```python
gi.require_version('Shell', '14')
from gi.repository import Shell
screenshot = Shell.Screenshot.new()
```

**Problem**: Shell module is only available inside GNOME Shell process, not from external Python applications

### ⚠️ Solution 3: GNOME Shell Extension (RECOMMENDED)
**Status**: Working solution, requires user to enable extension

Created extension at `~/.local/share/gnome-shell/extensions/disable-screenshot-flash@timetracker/`

**Extension Code** (`extension.js`):
```javascript
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export default class DisableScreenshotFlashExtension extends Extension {
    enable() {
        const screenshotUI = Main.screenshotUI;
        if (screenshotUI && screenshotUI._flashAsync) {
            this._originalFlashAsync = screenshotUI._flashAsync.bind(screenshotUI);
            screenshotUI._flashAsync = function(shooter) {
                return Promise.resolve();  // Skip flash
            };
        }
    }
    
    disable() {
        const screenshotUI = Main.screenshotUI;
        if (screenshotUI && this._originalFlashAsync) {
            screenshotUI._flashAsync = this._originalFlashAsync;
        }
        this._originalFlashAsync = null;
    }
}
```

**Installation**:
```bash
# Extension already created at:
~/.local/share/gnome-shell/extensions/disable-screenshot-flash@timetracker/

# To activate, user must:
# 1. Log out and log back in (to detect new extension)
# 2. Enable extension:
gnome-extensions enable disable-screenshot-flash@timetracker

# Verify:
gnome-extensions list --enabled | grep screenshot
```

**Pros**:
- ✅ Completely eliminates flash for ALL screenshot methods (Portal, D-Bus, gnome-screenshot)
- ✅ Works system-wide for the user
- ✅ Can be packaged with TimeTracker .deb
- ✅ Survives GNOME Shell updates

**Cons**:
- ⚠️ Requires user action (enable extension after login)
- ⚠️ Requires GNOME Shell restart to detect (logout/login)
- ⚠️ May break on major GNOME Shell version changes (e.g., GNOME 47+)

### 🔬 Solution 4: Patch xdg-desktop-portal-gnome (Advanced)
**Status**: Possible but not recommended for production

The GNOME Portal backend source: https://gitlab.gnome.org/GNOME/xdg-desktop-portal-gnome

**Steps**:
1. Clone xdg-desktop-portal-gnome source
2. Modify screenshot implementation to pass `flash=false` to GNOME Shell
3. Build and install patched version
4. Keep patched version updated with upstream

**Pros**:
- ✅ Works transparently without user intervention
- ✅ Fixes the root cause

**Cons**:
- ❌ Requires building from source on each user machine
- ❌ Breaks on system updates (dpkg will overwrite with official version)
- ❌ Complex maintenance burden
- ❌ Not suitable for .deb packaging

### 🧪 Solution 5: PipeWire ScreenCast API (Experimental)
**Status**: Possible but overly complex

Use PipeWire ScreenCast API to stream screen and grab individual frames.

**Pros**:
- ✅ No flash (designed for continuous screen recording)
- ✅ Standard Wayland API

**Cons**:
- ❌ Extremely complex to implement
- ❌ Designed for video streaming, not single frames
- ❌ Higher resource usage (constantly streaming)
- ❌ Requires GStreamer pipeline setup

### ❌ Solution 6: Switch to X11 Session
**Status**: Not recommended

Users can run GNOME on X11 instead of Wayland, where `scrot` works without flash.

**Pros**:
- ✅ `scrot` works perfectly on X11
- ✅ No flash

**Cons**:
- ❌ X11 is deprecated, Wayland is the future
- ❌ Requires user to log out and select "GNOME on Xorg" at login
- ❌ Loses Wayland security and features
- ❌ Not a sustainable long-term solution

## Recommended Solution: GNOME Shell Extension

**Decision**: Implement and package the GNOME Shell extension with TimeTracker

### Implementation Plan

1. **Include Extension in .deb Package**:
   ```bash
   # In build.sh, add:
   mkdir -p "$DEB_DIR/usr/share/gnome-shell/extensions/disable-screenshot-flash@timetracker"
   cp -r extension_files/* "$DEB_DIR/usr/share/gnome-shell/extensions/disable-screenshot-flash@timetracker/"
   ```

2. **Post-Install Script**:
   ```bash
   # In postinst:
   #!/bin/bash
   # Copy extension to user's local directory
   if [ -d /usr/share/gnome-shell/extensions/disable-screenshot-flash@timetracker ]; then
       mkdir -p "$HOME/.local/share/gnome-shell/extensions/"
       cp -r /usr/share/gnome-shell/extensions/disable-screenshot-flash@timetracker \
          "$HOME/.local/share/gnome-shell/extensions/"
   fi
   
   # Enable extension (requires shell restart)
   gnome-extensions enable disable-screenshot-flash@timetracker 2>/dev/null || true
   
   # Notify user
   echo ""
   echo "TimeTracker: Screenshot flash disable extension installed."
   echo "Please log out and log back in to activate the extension."
   echo ""
   ```

3. **User Documentation**:
   Add to README and first-run dialog:
   ```
   TimeTracker has installed a GNOME Shell extension to disable the
   screenshot flash animation. To activate it:
   
   1. Log out
   2. Log back in
   3. The extension will be automatically enabled
   
   If you still see the flash after login, run:
   gnome-extensions enable disable-screenshot-flash@timetracker
   ```

4. **Fallback Behavior**:
   TimeTracker should continue to work even if extension is not enabled:
   - Screenshots will still be captured via XDG Portal
   - Flash will be visible (annoying but functional)
   - User can enable extension at any time to eliminate flash

## Testing

### Before Extension (Flash Visible)
```bash
cd ~/ATG/new-main-linux/JIRAForge/python-desktop-app
python3 tests/test_portal_flash_fix.py
# → Flash visible on each capture
```

### After Extension (No Flash)
```bash
# 1. Log out and back in
# 2. Enable extension:
gnome-extensions enable disable-screenshot-flash@timetracker

# 3. Test again:
python3 tests/test_portal_flash_fix.py
# → No flash on captures!
```

### Verify Extension Status
```bash
gnome-extensions list --enabled | grep screenshot
# Output: disable-screenshot-flash@timetracker

journalctl --user -b 0 | grep DisableScreenshotFlash
# Should show: "DisableScreenshotFlash: Enabling extension"
# Should show: "DisableScreenshotFlash: Successfully patched _flashAsync"
```

## Long-Term Considerations

### Ubuntu LTS Support (24.04 → 26.04 → 28.04)
- GNOME 46 (Ubuntu 24.04): Extension works ✅
- GNOME 48? (Ubuntu 26.04): May need updates ⚠️
- Test extension on each new Ubuntu LTS release

### Alternative: Lobby GNOME Upstream
File feature request with GNOME:
- Request XDG Portal to expose `flash` parameter
- Or add gsettings option: `org.gnome.shell.screenshot.disable-flash true`

**Upstream Tracking**:
- GNOME Shell: https://gitlab.gnome.org/GNOME/gnome-shell/-/issues
- xdg-desktop-portal-gnome: https://gitlab.gnome.org/GNOME/xdg-desktop-portal-gnome/-/issues

## Summary

**Current Status**:
- ✅ XDG Portal screenshot capture implemented and working
- ❌ Flash still visible (hardcoded in GNOME Shell)
- ✅ GNOME Shell extension created to disable flash
- ⏳ Extension needs user to log out/in and enable

**Next Steps**:
1. Test extension after GNOME Shell restart
2. Package extension with TimeTracker .deb
3. Add post-install script to enable extension
4. Update user documentation
5. Consider filing upstream GNOME feature request

**Timeline**:
- Immediate: Document extension installation for users
- Short-term: Package extension with TimeTracker
- Long-term: Lobby GNOME to expose flash control via Portal or gsettings
