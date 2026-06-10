# GNOME Shell Extension: Disable Screenshot Flash

## Quick Install Guide

### What This Extension Does

Eliminates the camera flash animation that appears when TimeTracker captures screenshots on GNOME Wayland.

### Installation Steps

1. **Extension is Already Created**:
   ```bash
   ls ~/.local/share/gnome-shell/extensions/disable-screenshot-flash@timetracker/
   # Should show: extension.js  metadata.json
   ```

2. **Log Out and Log Back In**:
   - Click the power icon (top-right)
   - Select "Log Out"
   - Log back in with your credentials
   - This allows GNOME Shell to detect the new extension

3. **Enable the Extension**:
   ```bash
   gnome-extensions enable disable-screenshot-flash@timetracker
   ```

4. **Verify Installation**:
   ```bash
   gnome-extensions list --enabled | grep screenshot
   # Output: disable-screenshot-flash@timetracker
   ```

5. **Check Extension Logs**:
   ```bash
   journalctl --user -b 0 | grep DisableScreenshotFlash | tail -5
   # Should see: "DisableScreenshotFlash: Enabling extension"
   # Should see: "DisableScreenshotFlash: Successfully patched ScreenshotService._flashAsync"
   ```

### Testing

Run the test script to verify no flash appears:

```bash
cd ~/ATG/new-main-linux/JIRAForge/python-desktop-app
python3 tests/test_portal_flash_fix.py
```

**Expected Result**: 3 screenshots captured with NO visible flash

### Troubleshooting

#### Extension Not Listed
```bash
gnome-extensions list --user
# If disable-screenshot-flash@timetracker is NOT in the list:
# → Log out and back in (required for GNOME to detect new extensions)
```

#### Extension Fails to Enable
```bash
gnome-extensions info disable-screenshot-flash@timetracker
# Check for error messages

# View detailed logs:
journalctl --user -b 0 | grep -i "screenshot\|extension" | tail -30
```

#### Flash Still Visible After Enabling
1. Verify extension is enabled:
   ```bash
   gnome-extensions list --enabled | grep screenshot
   ```

2. Check logs for patching confirmation:
   ```bash
   journalctl --user -b 0 | grep "Successfully patched"
   ```

3. If patching failed, check GNOME Shell version:
   ```bash
   gnome-shell --version
   # Extension supports GNOME 45 and 46
   ```

### Uninstall

To remove the extension:

```bash
gnome-extensions disable disable-screenshot-flash@timetracker
rm -rf ~/.local/share/gnome-shell/extensions/disable-screenshot-flash@timetracker
```

### Technical Details

The extension works by:
1. Importing GNOME Shell's Screenshot service at runtime
2. Patching the `_flashAsync()` method to return immediately without showing flash
3. Restoring the original method when disabled

**Files**:
- `~/.local/share/gnome-shell/extensions/disable-screenshot-flash@timetracker/extension.js` - Main code
- `~/.local/share/gnome-shell/extensions/disable-screenshot-flash@timetracker/metadata.json` - Extension metadata

**Compatibility**:
- GNOME Shell 45 (Ubuntu 23.10)
- GNOME Shell 46 (Ubuntu 24.04 LTS)
- May need updates for GNOME 47+

### For .deb Package Maintainers

To include this extension in the TimeTracker .deb package:

1. **Add to Package**:
   ```bash
   # In build.sh:
   EXTENSION_DIR="$DEB_DIR/usr/share/gnome-shell/extensions/disable-screenshot-flash@timetracker"
   mkdir -p "$EXTENSION_DIR"
   cp extension.js "$EXTENSION_DIR/"
   cp metadata.json "$EXTENSION_DIR/"
   ```

2. **Post-Install Script** (`postinst`):
   ```bash
   #!/bin/bash
   set -e
   
   # Copy extension to each user's local directory
   for user_home in /home/*; do
       if [ -d "$user_home" ]; then
           user=$(basename "$user_home")
           ext_dir="$user_home/.local/share/gnome-shell/extensions/disable-screenshot-flash@timetracker"
           
           mkdir -p "$(dirname "$ext_dir")"
           cp -r /usr/share/gnome-shell/extensions/disable-screenshot-flash@timetracker "$ext_dir"
           chown -R "$user:$user" "$ext_dir"
       fi
   done
   
   echo ""
   echo "TimeTracker: Screenshot flash disable extension installed."
   echo "Please log out and log back in, then run:"
   echo "  gnome-extensions enable disable-screenshot-flash@timetracker"
   echo ""
   ```

3. **User Notification**:
   Show a dialog on first run:
   ```
   TimeTracker Screenshot Flash Fix
   
   To eliminate the flash animation when capturing screenshots:
   
   1. Log out and log back in
   2. Run: gnome-extensions enable disable-screenshot-flash@timetracker
   
   This is a one-time setup. TimeTracker will work without it,
   but you'll see a brief flash on each screenshot.
   ```
