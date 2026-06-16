# TimeTracker Linux Installation Guide

**Last Updated:** 2026-06-16  
**Supported Distributions:** Ubuntu 20.04 LTS+, Debian 11+, Linux Mint 20+

---

## Quick Start (Recommended)

### 1. Double-Click the .deb File

1. Download `timetracker_*.deb` from the release page
2. Double-click it in your file manager
3. Click **Install** in the app center window that opens
4. Enter your password if prompted (for dependency installation)
5. Wait for installation to complete

✓ Done! The app is now installed and ready to use.

### 2. Launch the App

- **From Applications Menu:** Search for "TimeTracker" and click it
- **From Terminal:** Type `timetracker` and press Enter

---

## What Happens During Installation

When you install TimeTracker via the .deb file:

### Step 1: Core Files Install
The app binary and desktop entry are copied to system directories:
- `/opt/timetracker/TimeTracker.AppImage` — the main app
- `/usr/local/bin/timetracker` — launcher wrapper

### Step 2: Auto-Dependency Resolution (Automatic)
The installer automatically detects and installs required system packages:
- **PipeWire** — multimedia server for Wayland screenshot capture
- **WirePlumber** (or **pipewire-media-session**) — session manager
- **GStreamer plugins** — video/audio processing (base, good, pipewire)
- **XDG Desktop Portal** — system API for permissions and screen access

**If a password prompt appears:** That's the installer asking permission to install these packages. This is normal and secure.

### Step 3: Per-User Setup
For each user on the system:
- Canonical AppImage copy created at `~/.local/share/TimeTracker/`
- Log and update directories scaffolded
- Desktop launcher entry created
- Screenshot flash fix extension installed (GNOME only)

---

## Installation Troubleshooting

### Issue: Installation Fails with "Dependency Error"

**Cause:** The app center couldn't resolve one of the required packages.

**Solution:**
1. **Option A (Recommended):** Install via terminal with apt:
   ```bash
   cd ~/Downloads
   sudo apt install ./timetracker_*.deb
   ```
   This ensures all dependencies (including Recommends) are resolved.

2. **Option B:** Manual dependency install:
   ```bash
   sudo apt update
   sudo apt install pipewire wireplumber gstreamer1.0-plugins-base \
                     gstreamer1.0-plugins-good gstreamer1.0-pipewire \
                     xdg-desktop-portal xdg-desktop-portal-gnome
   ```
   Then try the double-click install again.

---

### Issue: App Installs but Screenshot Capture Doesn't Work

**Cause:** One or more capture dependencies were skipped or not installed.

**Solution:**
1. Open a terminal and run the dependency checker:
   ```bash
   dpkg -l | grep -E "pipewire|wireplumber|gstreamer1.0-pipewire|xdg-desktop-portal"
   ```

2. If any are missing, install them:
   ```bash
   sudo apt install --install-recommends timetracker
   ```
   Or manually:
   ```bash
   sudo apt install pipewire wireplumber gstreamer1.0-pipewire xdg-desktop-portal
   ```

3. Restart the app:
   ```bash
   killall TimeTracker
   timetracker &
   ```

---

### Issue: "Permission Denied" When Installing Dependencies

**Cause:** User doesn't have sudo/pkexec permission, or system policies restrict auto-install.

**Solution:**
1. Ask your system administrator to run:
   ```bash
   sudo apt install pipewire wireplumber gstreamer1.0-pipewire xdg-desktop-portal
   ```

2. Or contact support with:
   ```bash
   apt list --installed | grep -E "pipewire|wireplumber|gstreamer|portal"
   ```

---

### Issue: App Crashes on First Launch

**Cause:** Capture stack services (PipeWire, xdg-desktop-portal) haven't started yet.

**Solution:**
1. Reboot your system (ensures all services start):
   ```bash
   sudo reboot
   ```

2. Try launching again:
   ```bash
   timetracker
   ```

---

## Advanced Configuration

### Disable Auto-Dependency Install (Not Recommended)

If you're on a restricted system where automatic installs aren't allowed:

1. Edit `/tmp/timetracker-deps-install.log` to see which packages were attempted
2. Contact your administrator to install those packages manually

### Manual Installation Without App Center

```bash
# Download the .deb
cd ~/Downloads

# Install with apt (resolves all dependencies automatically)
sudo apt install ./timetracker_*.deb

# Or, for systems with restricted recommends:
sudo apt install --install-recommends ./timetracker_*.deb
```

---

## System Requirements

### Minimum
- Ubuntu 20.04 LTS, Debian 11, or Linux Mint 20+
- 500 MB free disk space
- 2 GB RAM minimum (4 GB recommended)

### Screenshot Capture (Wayland)
- **PipeWire** 0.3+ or PulseAudio + ALSA
- **WirePlumber** or **pipewire-media-session**
- **GStreamer 1.0** with good/base/pipewire plugins
- **XDG Desktop Portal** 1.10+
- **xdg-desktop-portal-gnome** (GNOME) or **xdg-desktop-portal-gtk** (GTK)

### Desktop Environment Support
- ✅ GNOME 42+ (Wayland & X11)
- ✅ Ubuntu Desktop (GNOME-based)
- ✅ Linux Mint (Cinnamon, MATE, Xfce)
- ✅ KDE Plasma 5.20+
- ✅ Xfce 4.16+

---

## Uninstalling TimeTracker

### Method 1: App Center GUI (Easiest)
1. Open Applications
2. Search for "TimeTracker"
3. Click the app entry
4. Click **Uninstall**

### Method 2: Built-in Uninstaller
```bash
# Auto-generated uninstaller (if present)
~/.local/share/TimeTracker/uninstall.sh
```

### Method 3: Terminal
```bash
sudo apt remove timetracker
```

### Method 4: Clean Uninstall
```bash
# Remove the app package
sudo apt remove --purge timetracker

# Remove user data (optional)
rm -rf ~/.local/share/TimeTracker/
rm -rf ~/.config/autostart/timetracker.desktop
```

---

## Verification

After installation, verify everything is working:

```bash
# Check if TimeTracker is installed
which timetracker

# Check if capture dependencies are installed
dpkg -l | grep -E "pipewire|wireplumber|gstreamer1.0-pipewire|xdg-desktop-portal"

# Check if app can start (should show no errors)
timetracker --version 2>&1

# Check if PipeWire is running
systemctl --user status pipewire

# Check if xdg-desktop-portal is running
ps aux | grep xdg-desktop-portal
```

Expected output:
- ✅ `timetracker` command exists
- ✅ All capture packages show as "ii" (installed)
- ✅ PipeWire service shows "active (running)"
- ✅ xdg-desktop-portal process is listed

---

## Getting Help

### Installation Logs
If installation fails, check:
- `/tmp/timetracker-deps-install.log` — dependency install details
- `/home/USERNAME/.local/share/TimeTracker/logs/` — app runtime logs

### Support Resources
- **Bug Reports:** GitHub Issues
- **Documentation:** https://docs.timetracker.app/
- **Community:** Discussions forum

### Collect Debug Info for Support
```bash
# Create a debug info bundle
(
  echo "=== System Info ==="
  uname -a
  lsb_release -a
  
  echo ""
  echo "=== Installed Packages ==="
  dpkg -l | grep -E "timetracker|pipewire|wireplumber|gstreamer|portal"
  
  echo ""
  echo "=== TimeTracker Version ==="
  timetracker --version 2>&1 || echo "Not installed or error"
  
  echo ""
  echo "=== Recent Logs ==="
  tail -50 ~/.local/share/TimeTracker/logs/timetracker.log 2>/dev/null || echo "No logs yet"
) > ~/timetracker-debug-info.txt

# Share this file with support
cat ~/timetracker-debug-info.txt
```

---

## FAQ

### Q: Do I need to enter my password during installation?
**A:** Yes, only when the installer needs to install system packages (PipeWire, GStreamer, etc.). This is secure and required for screenshot capture to work.

### Q: Why does the app need all these dependencies?
**A:** TimeTracker captures screenshots using PipeWire on Wayland (the modern Linux display system). PipeWire requires GStreamer plugins and XDG Desktop Portal to function securely.

### Q: Can I use TimeTracker on X11 instead of Wayland?
**A:** Yes, but some features may require PipeWire anyway. We recommend Wayland on modern systems (Ubuntu 22.04+) for best security and performance.

### Q: What if my distro doesn't have some of these packages?
**A:** Contact support with the output of:
   ```bash
   apt list --installed | grep -E "pipewire|portal"
   ```
   We may have a workaround or alternative for your distro.

### Q: Can I use a different session manager (not WirePlumber)?
**A:** Yes, PipeWire works with **pipewire-media-session** as an alternative. Both are equivalent.

### Q: Is it safe to auto-install these dependencies?
**A:** Yes. These are standard Ubuntu/Debian packages used by many GNOME and GTK applications. They're maintained by the respective projects and Ubuntu/Debian teams.

---

## See Also

- [Build & Packaging](BUILD.md)
- [Troubleshooting Guide](TROUBLESHOOTING.md)
- [System Requirements](REQUIREMENTS.md)
