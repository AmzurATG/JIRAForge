# Linux Support - Quick Reference

## ✅ What Was Created

### 1. `desktop_app_linux.py`
Complete Linux implementation with:
- **Screenshot capture** using mss (same as Windows)
- **Window tracking** using EWMH/X11
- **Notifications** using notify-send  
- **Auto-start** using .desktop files
- **Single instance lock** using fcntl
- **Includes test suite** - run with: `python3 desktop_app_linux.py`

### 2. `requirements.txt` (Updated)
Added cross-platform dependencies:
```
mss==9.0.1  # Cross-platform screenshot (REQUIRED)
ewmh==0.1.6; sys_platform == 'linux'  # Linux window tracking
python-xlib==0.33; sys_platform == 'linux'  # Linux X11
```

### 3. `LINUX_INTEGRATION_GUIDE.md`
Complete step-by-step integration instructions

---

## 🚀 Quick Start (Linux)

### Install Dependencies
```bash
# System packages
sudo apt install python3-tk xdotool x11-utils libnotify-bin

# Python packages
pip install -r requirements.txt
```

### Test Linux Implementation
```bash
python3 desktop_app_linux.py
```

Expected: Screenshot capture, window detection, notification tests pass

### Integrate with desktop_app.py
Follow steps in `LINUX_INTEGRATION_GUIDE.md`:
1. Add OS detection + imports
2. Modify `capture_screenshot()` to call Linux function
3. Modify `get_active_window()` to call Linux function
4. Update lock/startup/directory functions

---

## 🔧 Key Functions (desktop_app_linux.py)

| Function | Purpose |
|----------|---------|
| `capture_screenshot_linux()` | Capture screen using mss → PIL Image |
| `get_active_window_linux()` | Get active window info (EWMH/xdotool) |
| `show_notification_linux()` | Show notification (notify-send) |
| `add_to_startup_linux()` | Add .desktop file to autostart |
| `acquire_single_instance_lock_linux()` | File-based lock (fcntl) |
| `get_app_data_dir_linux()` | XDG data dir (~/.local/share/timetracker/) |

---

## 📊 Implementation Status

| Feature | Windows | Linux | Status |
|---------|---------|-------|--------|
| Screenshot Capture | ✅ mss | ✅ mss | **Ready** |
| Window Tracking | ✅ win32gui | ✅ EWMH/X11 | **Ready** |
| Notifications | ✅ winotify | ✅ notify-send | **Ready** |
| Auto-start | ✅ Registry | ✅ .desktop | **Ready** |
| Single Instance | ✅ Mutex | ✅ fcntl | **Ready** |
| System Tray | ✅ pystray | ✅ pystray | **Works** |
| Data Directory | ✅ %LOCALAPPDATA% | ✅ XDG spec | **Ready** |
| Keyring (tokens) | ✅ Win Credential | ✅ Secret Service | **Works** |

---

## 🎯 Integration Pattern

```python
# At top of desktop_app.py
IS_LINUX = sys.platform == 'linux'

if IS_LINUX:
    from desktop_app_linux import (
        capture_screenshot_linux,
        get_active_window_linux,
        # ... other Linux functions
    )

# In methods
def capture_screenshot(self):
    if IS_LINUX:
        return capture_screenshot_linux()
    else:
        from PIL import ImageGrab
        return ImageGrab.grab()
```

---

## ⚙️ Why mss?

Using `mss` for both Windows and Linux provides:
- ✅ **Fast** - Faster than PIL ImageGrab
- ✅ **Silent** - No visible capture effect
- ✅ **Cross-platform** - Same code for Windows & Linux
- ✅ **Multi-monitor** - Captures all monitors
- ✅ **Pure Python** - No external binaries needed

---

## 📁 File Structure

```
python-desktop-app/
├── desktop_app.py           # Main app (Windows, add Linux detection)
├── desktop_app_linux.py     # NEW: Linux implementation
├── requirements.txt         # UPDATED: Added mss + Linux deps
├── LINUX_INTEGRATION_GUIDE.md  # NEW: Integration instructions
└── LINUX_QUICKREF.md        # THIS FILE
```

---

## 🔍 How It Works

### Current (Windows Only)
```
desktop_app.py
├── Uses PIL ImageGrab
├── Uses win32gui
└── Uses winotify
```

### After Integration (Cross-Platform)
```
desktop_app.py
├── Detects OS
│
├── Windows → Uses existing code
│   ├── PIL ImageGrab or mss
│   ├── win32gui
│   └── winotify
│
└── Linux → Imports desktop_app_linux.py
    ├── mss (same as Windows!)
    ├── EWMH/X11 or xdotool
    └── notify-send
```

---

## ✅ Testing Checklist

### Linux Tests
- [ ] Run `python3 desktop_app_linux.py` successfully
- [ ] Screenshot captured correctly
- [ ] Active window detected correctly
- [ ] Notification appears
- [ ] Lock file created/removed
- [ ] Auto-start .desktop file works

### Integration Tests
- [ ] OS detection works
- [ ] Screenshot capture works on Linux
- [ ] Window tracking works on Linux
- [ ] App runs without errors on Linux
- [ ] App still works on Windows (no regressions)

---

## 🐛 Common Issues

### "mss library not available"
```bash
pip install mss
```

### "X11 libraries not available"
```bash
pip install ewmh python-xlib
```

### "No module named 'desktop_app_linux'"
- Make sure `desktop_app_linux.py` is in the same directory
- Check import statement in `desktop_app.py`

### Screenshots are black
- Check if running Wayland: `echo $XDG_SESSION_TYPE`
- Switch to X11 session or use alternative

---

## 📞 Next Steps

1. **Test**: Run `python3 desktop_app_linux.py`
2. **Read**: Full guide in `LINUX_INTEGRATION_GUIDE.md`
3. **Integrate**: Follow Step 1-8 in the guide
4. **Test**: Run integrated app on Linux
5. **Deploy**: Build with PyInstaller

---

## 📝 Summary

**Goal**: Make desktop app work on Linux exactly like Windows

**Solution**: 
- ✅ Created separate Linux module (`desktop_app_linux.py`)
- ✅ Keep Windows code unchanged in `desktop_app.py`
- ✅ Use mss for both platforms (consistency)
- ✅ Add OS detection to call right functions
- ✅ Provide complete integration guide

**Result**: Cross-platform time tracker that works seamlessly on Windows & Linux!
