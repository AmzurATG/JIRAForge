# TimeTracker OCR Issue - User Quick Fix Guide

## Issue Summary

Your TimeTracker application is working, but **OCR (text recognition from screenshots) is not functioning**. Instead, the system is only recording window titles and application names (metadata).

**This is NOT a bug in the application** - it's a missing system dependency issue on Wayland Linux systems.

---

## Quick Diagnosis

Run this command to check your system:
```bash
echo "Wayland: $WAYLAND_DISPLAY"
ps aux | grep pipewire | grep -v grep
gst-inspect-1.0 pipewiresrc 2>&1 | head -3
```

If you see:
- ✅ Wayland display variable set
- ❌ No PipeWire processes running
- ❌ "No such element" for pipewiresrc

**Then you need to install the dependencies below.**

---

## One-Command Fix

Run our automated fix script:

```bash
cd /path/to/JIRAForge
./scripts/fix-screenshot-capture.sh
```

This will:
1. Check your current system state
2. Install required packages (PipeWire, GStreamer, XDG Portal)
3. Restart services
4. Verify the installation

---

## Manual Installation Steps

If you prefer to install manually:

### 1. Install Required Packages

```bash
sudo apt update
sudo apt install -y \
    pipewire \
    wireplumber \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad \
    gstreamer1.0-pipewire \
    xdg-desktop-portal \
    xdg-desktop-portal-gnome
```

### 2. Restart PipeWire Services

```bash
systemctl --user restart pipewire pipewire-pulse wireplumber
```

### 3. Verify Installation

```bash
# Check PipeWire is running
ps aux | grep pipewire

# Check GStreamer plugin is available
gst-inspect-1.0 pipewiresrc

# Check ScreenCast Portal is available
gdbus introspect --session \
  --dest org.freedesktop.portal.Desktop \
  --object-path /org/freedesktop/portal/desktop \
  | grep ScreenCast
```

All three commands should return results (not errors).

### 4. Restart TimeTracker

Close and reopen the TimeTracker application.

### 5. Grant Screenshot Permission

**IMPORTANT:** When you first use TimeTracker after the fix:
1. A system dialog will appear asking for screenshot permission
2. **You MUST click "Allow"** or "Share Screen"
3. This is a one-time consent requirement
4. If you click "Deny", OCR will not work

---

## Verification

After installation and restarting the app, check the logs:

```bash
tail -f ~/.local/share/TimeTracker/logs/timetracker.log | grep -E "OCR|ScreenCast|capture"
```

### ✅ Success Indicators

You should see:
```
[INFO] ScreenCast Portal available - flash-free captures enabled
[OCR] RapidOCR: extracted 1234 chars (confidence: 0.87)
[OK] Activity record uploaded with OCR text
```

### ❌ Failure Indicators

If you still see:
```
WARNING - monitor_capture - gnome-screenshot produced an all-black image
WARNING - ocr.facade - All OCR engines failed. Details: rapidocr: Confidence too low (0.00 < 0.6 threshold)
[OCR-ASYNC] capture failed (metadata)
```

**Then:**
1. Log out and log back in (to restart all user services)
2. Run the fix script again
3. Restart TimeTracker
4. Grant permission when prompted

---

## Alternative: Run in X11 Mode (Workaround)

If you can't install the packages or the fix doesn't work, run TimeTracker in X11 compatibility mode:

```bash
GDK_BACKEND=x11 ~/.local/share/TimeTracker/TimeTracker.AppImage
```

**Note:** This is a workaround, not a permanent solution. X11 mode may have other limitations.

---

## What You'll Get After the Fix

### Before Fix (Metadata-Only Mode)
- ✅ Window title tracked: "Visual Studio Code - myfile.py"
- ✅ Application name: "code"
- ❌ **No screen content** captured
- ❌ **Cannot detect JIRA keys** in code/documents
- ❌ **Cannot enhance classification** with context

**Database shows:** `method: 'metadata'`, `confidence: 0.0`, `text: ''`

### After Fix (Full OCR Mode)
- ✅ Window title tracked
- ✅ Application name
- ✅ **Screen content OCR'd:** "def calculate_tax(amount): JIRA-1234..."
- ✅ **Detects JIRA keys** in editors: "JIRA-1234"
- ✅ **Enhanced classification** with context
- ✅ **Privacy filtering** for sensitive data

**Database shows:** `method: 'rapidocr'`, `confidence: 0.87`, `text: 'actual screen content...'`

---

## Why This Happens

### Technical Explanation

Wayland (modern Linux display server) requires special APIs to capture screenshots:

1. **ScreenCast Portal** - Best method, no flash, requires PipeWire + GStreamer
2. **XDG Portal** - Standard API, requires portal backend
3. **GNOME D-Bus** - Legacy, restricted in GNOME 46+
4. **gnome-screenshot** - Produces black images without portal support

Your system was missing PipeWire/GStreamer, so ALL methods failed → OCR got black images → fell back to metadata.

---

## Troubleshooting

### Issue: "Another instance is already running"

Kill existing instance first:
```bash
pkill -f TimeTracker
```

### Issue: "ScreenCast Portal not available after installation"

Try restarting the portal service:
```bash
systemctl --user restart xdg-desktop-portal
systemctl --user restart xdg-desktop-portal-gnome
```

### Issue: "Permission denied" on consent dialog

The portal may have cached a "deny" decision. Reset it:
```bash
rm -rf ~/.local/share/xdg-desktop-portal/
```

Then restart TimeTracker and grant permission when prompted.

### Issue: "All-black images still appearing"

Check if GNOME Shell has restricted screenshot access:
```bash
dconf read /org/gnome/shell/introspect
```

If it shows `false`, enable it:
```bash
dconf write /org/gnome/shell/introspect true
```

### Issue: "GStreamer plugin not found"

Install additional plugin package:
```bash
sudo apt install gstreamer1.0-plugins-bad
```

---

## Support

If the issue persists after following all steps:

1. **Collect diagnostic info:**
   ```bash
   # Create diagnostic report
   cat > /tmp/timetracker-diag.txt <<EOF
   System: $(uname -a)
   Wayland: $WAYLAND_DISPLAY
   GNOME: $(gnome-shell --version)
   
   PipeWire:
   $(ps aux | grep pipewire | grep -v grep)
   
   GStreamer:
   $(gst-inspect-1.0 pipewiresrc 2>&1 | head -10)
   
   Portal:
   $(gdbus introspect --session --dest org.freedesktop.portal.Desktop --object-path /org/freedesktop/portal/desktop 2>&1 | grep -A5 ScreenCast)
   
   Recent Logs:
   $(tail -50 ~/.local/share/TimeTracker/logs/timetracker.log)
   EOF
   
   cat /tmp/timetracker-diag.txt
   ```

2. **Share the output** with support team

3. **Reference document:** `docs/OCR_FAILURE_ROOT_CAUSE_ANALYSIS.md`

---

## Quick Reference

| Command | Purpose |
|---------|---------|
| `./scripts/fix-screenshot-capture.sh` | Run automated fix |
| `ps aux \| grep pipewire` | Check PipeWire running |
| `gst-inspect-1.0 pipewiresrc` | Check GStreamer plugin |
| `tail -f ~/.local/share/TimeTracker/logs/timetracker.log` | Monitor logs |
| `pkill -f TimeTracker` | Kill running instance |
| `systemctl --user restart pipewire` | Restart PipeWire |

---

## FAQ

**Q: Will this fix affect my audio?**  
A: No, PipeWire is a modern replacement for PulseAudio. It handles both audio and video streams.

**Q: Do I need to run the fix script every time?**  
A: No, once installed, the packages persist across reboots.

**Q: What if I'm on Ubuntu 20.04 or older?**  
A: Older Ubuntu versions may not have PipeWire in default repositories. Consider upgrading to Ubuntu 22.04+ or install from PPA.

**Q: Can I use the app without OCR?**  
A: Yes, it works in metadata-only mode, but accuracy is reduced. Issue detection relies on window titles only.

**Q: Does this compromise security?**  
A: No, the ScreenCast Portal requires explicit user consent. You control what gets captured.

---

## Summary Checklist

- [ ] Run `./scripts/fix-screenshot-capture.sh`
- [ ] Verify all checks pass
- [ ] Restart TimeTracker application
- [ ] **Grant screenshot permission when prompted** (critical!)
- [ ] Check logs for `ScreenCast Portal available`
- [ ] Verify OCR is working: look for `method: 'rapidocr'` in database

---

**Need Help?** See `docs/OCR_FAILURE_ROOT_CAUSE_ANALYSIS.md` for deep technical details.
