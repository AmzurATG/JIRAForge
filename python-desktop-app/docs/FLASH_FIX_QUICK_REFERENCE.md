# Screenshot Flash Fix - Quick Reference

## Problem
TimeTracker continuously captures screenshots every 5-15 minutes. GNOME Wayland shows a flash animation each time, which annoys users.

## Solution
GNOME Shell extension that disables the flash animation.

## Current Status
- ✅ Extension created at: `~/.local/share/gnome-shell/extensions/disable-screenshot-flash@timetracker/`
- ⏳ Needs GNOME Shell restart to activate
- ⏳ User needs to enable extension

## Action Required (You Must Do This)

### Step 1: Restart GNOME Shell
**Log out and log back in** (required for GNOME to detect the new extension)

```bash
# Click power icon → Log Out → Log back in
```

### Step 2: Enable Extension
```bash
gnome-extensions enable disable-screenshot-flash@timetracker
```

### Step 3: Verify
```bash
gnome-extensions list --enabled | grep screenshot
# Should output: disable-screenshot-flash@timetracker
```

### Step 4: Test
```bash
cd ~/ATG/new-main-linux/JIRAForge/python-desktop-app
python3 tests/test_portal_flash_fix.py
```

**Expected**: 3 screenshots captured with **NO visible flash**

## If Extension Not Found

If `gnome-extensions` says the extension doesn't exist:

1. **Verify files exist**:
   ```bash
   ls ~/.local/share/gnome-shell/extensions/disable-screenshot-flash@timetracker/
   # Should show: extension.js  metadata.json
   ```

2. **Must log out/in** - GNOME only scans for extensions at login

3. **Try again after login**:
   ```bash
   gnome-extensions enable disable-screenshot-flash@timetracker
   ```

## Troubleshooting

### Check Extension Status
```bash
gnome-extensions info disable-screenshot-flash@timetracker
```

### Check Extension Logs
```bash
journalctl --user -b 0 | grep DisableScreenshotFlash | tail -10
```

**Should see**:
- `DisableScreenshotFlash: Enabling extension`
- `DisableScreenshotFlash: Successfully patched ScreenshotService._flashAsync`

### If Flash Still Visible

1. **Confirm extension enabled**:
   ```bash
   gnome-extensions list --enabled | grep screenshot
   ```

2. **Check GNOME Shell version**:
   ```bash
   gnome-shell --version
   # Extension supports GNOME 45 and 46
   ```

3. **View extension logs**:
   ```bash
   journalctl --user -b 0 | grep -i "screenshot\|DisableScreenshotFlash" | tail -20
   ```

## How It Works

The extension patches GNOME Shell's screenshot service at runtime:

```javascript
// Before: Flash shown
_flashAsync(shooter) {
    // ... creates Flashspot animation (500ms white flash) ...
}

// After: Flash skipped
_flashAsync(shooter) {
    return Promise.resolve();  // No flash!
}
```

**Affects**: ALL screenshot methods (XDG Portal, GNOME Screenshot, Print Screen key)

## Uninstall (If Needed)

```bash
gnome-extensions disable disable-screenshot-flash@timetracker
rm -rf ~/.local/share/gnome-shell/extensions/disable-screenshot-flash@timetracker
```

Then log out and back in.

## Files Created

### Extension
- `~/.local/share/gnome-shell/extensions/disable-screenshot-flash@timetracker/extension.js`
- `~/.local/share/gnome-shell/extensions/disable-screenshot-flash@timetracker/metadata.json`

### Documentation
- `docs/FLASH_ELIMINATION_COMPLETE_ANALYSIS.md` - Complete analysis (this investigation)
- `docs/SCREENSHOT_FLASH_SOLUTION.md` - Solutions evaluated
- `docs/FLASH_EXTENSION_INSTALL.md` - Installation guide
- `docs/FLASH_FIX_QUICK_REFERENCE.md` - **This document**
- `docs/LINUX_SCREENSHOT_ALTERNATIVES_ANALYSIS.md` - Technical deep-dive

### Tests
- `tests/test_portal_flash_fix.py` - Test flash behavior
- `tests/test_portal_availability.py` - Check environment
- `tests/test_screenshot_methods.sh` - Test all methods

## Support

### Compatibility
- ✅ Ubuntu 24.04 LTS (GNOME 46)
- ✅ Ubuntu 23.10 (GNOME 45)
- ⚠️ May need updates for GNOME 47+ (future releases)

### Alternative Solutions
If extension doesn't work:
1. **X11 Session**: Log out → Gear icon → "GNOME on Xorg" → scrot will work (but X11 is deprecated)
2. **Accept Flash**: TimeTracker will work, flash is just visual annoyance
3. **Reduce Frequency**: Set screenshot interval to maximum (less frequent = less annoying)

### Upstream Issue
Consider filing GNOME feature request:
- Request: XDG Portal should expose `flash` parameter
- Or: Add gsettings `org.gnome.shell.screenshot.disable-flash`
- Where: https://gitlab.gnome.org/GNOME/xdg-desktop-portal-gnome/-/issues

## Summary

**What You Need To Do**:
1. Log out and log back in
2. Run: `gnome-extensions enable disable-screenshot-flash@timetracker`
3. Test: `python3 tests/test_portal_flash_fix.py`
4. Confirm: No flash visible during captures

**Why This Works**:
Extension patches GNOME Shell's flash animation function to skip the flash for all screenshot captures.

**Production Ready**:
Once tested, extension can be packaged with TimeTracker .deb for automatic installation.

---

**Need Help?** Check the detailed docs:
- Full analysis: `docs/FLASH_ELIMINATION_COMPLETE_ANALYSIS.md`
- Installation guide: `docs/FLASH_EXTENSION_INSTALL.md`
- Technical details: `docs/SCREENSHOT_FLASH_SOLUTION.md`
