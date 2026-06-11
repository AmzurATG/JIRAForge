# OCR Issue - Quick Reference Card

## 🚨 The Problem
Database shows `method: 'metadata'` instead of `method: 'rapidocr'`
- Text field is empty: `text: ''`
- Confidence is zero: `confidence: 0.0`
- Only window title and app name are captured

## 🎯 Root Cause
**Screenshot capture failing on Wayland** → OCR gets black images → falls back to metadata

## 🔧 One-Line Fix
```bash
./scripts/fix-screenshot-capture.sh
```

## 📋 Quick Diagnosis
```bash
# Check if you're on Wayland
echo "Wayland: $WAYLAND_DISPLAY"

# Check PipeWire (should show processes)
ps aux | grep pipewire | grep -v grep

# Check GStreamer (should NOT say "No such element")
gst-inspect-1.0 pipewiresrc 2>&1 | head -3
```

## ✅ Success Checklist
- [ ] Run `./scripts/fix-screenshot-capture.sh`
- [ ] All verification checks pass (green checkmarks)
- [ ] Restart TimeTracker application
- [ ] **Click "Allow" on screenshot permission dialog** (CRITICAL!)
- [ ] Check logs: `tail -f ~/.local/share/TimeTracker/logs/timetracker.log`
- [ ] Look for: `ScreenCast Portal available`
- [ ] Look for: `RapidOCR: extracted N chars (confidence: 0.XX)`

## 🔍 Log Patterns

### ✅ Working (After Fix)
```
[INFO] ScreenCast Portal available - flash-free captures enabled
[OCR] RapidOCR: extracted 1234 chars (confidence: 0.87)
[OK] Activity record uploaded with OCR text
```

### ❌ Broken (Before Fix)
```
WARNING - gnome-screenshot produced an all-black image
WARNING - scrot produced an all-black image
WARNING - All OCR engines failed. Details: rapidocr: Confidence too low (0.00)
[OCR-ASYNC] capture failed (metadata)
```

## 🆘 If Fix Doesn't Work

### 1. Log out and back in
```bash
# Restart all user services
gnome-session-quit --logout
```

### 2. Restart portal service
```bash
systemctl --user restart xdg-desktop-portal
systemctl --user restart xdg-desktop-portal-gnome
```

### 3. Clear portal cache
```bash
rm -rf ~/.local/share/xdg-desktop-portal/
```

### 4. Check GNOME introspect
```bash
# Should show 'true'
dconf read /org/gnome/shell/introspect

# If 'false', enable it
dconf write /org/gnome/shell/introspect true
```

### 5. Workaround: Use X11 mode
```bash
GDK_BACKEND=x11 ~/.local/share/TimeTracker/TimeTracker.AppImage
```

## 📚 Full Documentation
- User Guide: `docs/USER_FIX_GUIDE_OCR_ISSUE.md`
- Technical Analysis: `docs/OCR_FAILURE_ROOT_CAUSE_ANALYSIS.md`
- Investigation Summary: `docs/OCR_INVESTIGATION_SUMMARY.md`

## 🎯 What You Get After Fix

| Before (Metadata Only) | After (Full OCR) |
|------------------------|------------------|
| Window title only | Window title + full screen text |
| `method: 'metadata'` | `method: 'rapidocr'` |
| `confidence: 0.0` | `confidence: 0.60-0.95` |
| `text: ''` | `text: 'actual screen content...'` |
| Can't find JIRA keys in code | Finds JIRA keys everywhere |
| Basic classification | Context-aware classification |

## 💡 Key Insight
**This is NOT an OCR bug.** The OCR engine (RapidOCR) works perfectly. The issue is that Wayland requires special system packages (PipeWire + GStreamer) to capture screenshots, and these are missing on the user's system.

## 🚀 Expected Timeline
- **Install dependencies:** 2-5 minutes
- **Restart app + grant permission:** 1 minute
- **Verify working:** Immediate
- **Total:** ~5-10 minutes

## ☎️ Support
If issue persists after all steps:
1. Collect diagnostic info: See USER_FIX_GUIDE.md "Support" section
2. Check system logs: `journalctl --user -xe | grep portal`
3. Share logs with development team

---

**Quick Answer:** Install PipeWire + GStreamer → Restart → Grant permission → OCR works! 🎉
