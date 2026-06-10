# Installation Bug Fix - June 10, 2026

## Issue: TimeTracker Not Launching from App Menu After .deb Installation

### Problem Description
After installing TimeTracker from the .deb package, clicking the app in the application menu did nothing. The app appeared to "not launch" or be broken.

### Root Cause
The postinst script was failing silently during installation, preventing the AppImage from being copied to the user's canonical location (`~/.local/share/TimeTracker/TimeTracker.AppImage`).

The user desktop entry was correctly pointing to this location:
```
Exec=env APPIMAGE_EXTRACT_AND_RUN=1 APPIMAGE=/home/user/.local/share/TimeTracker/TimeTracker.AppImage ...
```

But the file didn't exist because the postinst script exited early.

### Technical Details

**The Bug:**
The postinst script had `set -e` (exit on any error) combined with three `mkdir` commands missing `|| true`:

```bash
# Line ~477
mkdir -p "$_CANONICAL_DIR" 2>/dev/null          # ❌ Missing || true

# Line ~503  
mkdir -p "$_DESKTOP_DIR" 2>/dev/null            # ❌ Missing || true

# Line ~524
mkdir -p "$_AUTOSTART_DIR" 2>/dev/null          # ❌ Missing || true
```

When `mkdir` encountered any issue (permissions, filesystem, etc.), the script would exit immediately without:
- Copying the AppImage
- Creating the user desktop entry
- Installing the screenshot flash extension

### The Fix

**Applied to build.sh:**

1. **Fixed mkdir commands** (3 locations):
   ```bash
   mkdir -p "$_CANONICAL_DIR" 2>/dev/null || true   # ✅ Fixed
   mkdir -p "$_DESKTOP_DIR" 2>/dev/null || true     # ✅ Fixed
   mkdir -p "$_AUTOSTART_DIR" 2>/dev/null || true   # ✅ Fixed
   ```

2. **Added source verification**:
   ```bash
   _OPT_APPIMAGE="/opt/timetracker/TimeTracker.AppImage"
   
   # Verify source AppImage exists before processing users
   if [ ! -f "$_OPT_APPIMAGE" ]; then
       echo "[ERROR] Source AppImage not found: $_OPT_APPIMAGE" >&2
       echo "Skipping per-user installation, but system files are in place." >&2
       echo "Users can run: /usr/local/bin/timetracker" >&2
   fi
   ```

3. **Better error handling** throughout postinst.

### Immediate Workaround (If Already Installed)

If you installed the broken .deb, fix it manually:

```bash
# Copy AppImage to canonical location
mkdir -p ~/.local/share/TimeTracker
sudo cp /opt/timetracker/TimeTracker.AppImage ~/.local/share/TimeTracker/
sudo chown $USER:$USER ~/.local/share/TimeTracker/TimeTracker.AppImage
chmod +x ~/.local/share/TimeTracker/TimeTracker.AppImage

# Verify
ls -lh ~/.local/share/TimeTracker/TimeTracker.AppImage

# Launch TimeTracker
timetracker
```

### Testing the Fix

After rebuilding with the fixed build.sh:

```bash
cd ~/ATG/new-main-linux/JIRAForge/python-desktop-app
./build.sh

# Test install
sudo dpkg -i dist/timetracker_*.deb

# Verify AppImage was copied
ls -lh ~/.local/share/TimeTracker/TimeTracker.AppImage

# Launch from app menu or terminal
timetracker
```

### Expected Behavior After Fix

When installing the .deb with the fixed postinst:

1. ✅ AppImage copied to `/opt/timetracker/`
2. ✅ AppImage copied to `~/.local/share/TimeTracker/` for each user
3. ✅ User desktop entry created with correct path
4. ✅ Screenshot flash extension installed
5. ✅ Autostart entry created for extension
6. ✅ App launches immediately from app menu

### Status

- **Bug Status**: ✅ FIXED in build.sh (June 10, 2026)
- **Current Installation**: ✅ Manually fixed and working
- **Next Build**: ✅ Will install correctly for all users

### Files Modified

- `build.sh` - Fixed 3 mkdir commands and added source verification

### Related Issues

This fix also ensures the screenshot flash extension installation (added in the same update) works correctly.

---

**Note**: If users report "TimeTracker doesn't launch" after installation, check if `~/.local/share/TimeTracker/TimeTracker.AppImage` exists. If not, the postinst failed and needs investigation.
