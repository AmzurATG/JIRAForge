# TimeTracker for Linux

Linux client for the BRD Time Tracker. It reuses the shared core in `../python-desktop-app/` (auth, sessions, upload, OCR, privacy filter, local database) and adds everything Linux-specific here: window tracking, screen capture, idle and lock detection, tray, notifications, packaging.

- Plan and status: [plan/2026-09-29_linux-desktop-app_implementation-plan.md](plan/2026-09-29_linux-desktop-app_implementation-plan.md)
- Admin / IT deployment: [../docs/LINUX_DESKTOP_APP_ADMIN_GUIDE.md](../docs/LINUX_DESKTOP_APP_ADMIN_GUIDE.md)

## How it fits together

```
python -m timetracker_linux  (or /opt/timetracker/TimeTracker)
  └─ launcher.py
       ├─ registers LinuxPlatformProvider in python-desktop-app/platform_hooks.py
       ├─ installs the winotify adapter (compat/winotify.py) and the SNI tray (compat/tray_sni.py)
       └─ runs desktop_app.main()  ← shared core, unchanged behaviour on Windows
```

The provider picks backends per desktop (`selection.py`):

| Desktop | Window info | Screen capture | Idle |
|---|---|---|---|
| X11 (any) | EWMH | XShm of the focused monitor | XScreenSaver |
| GNOME Wayland | our GNOME Shell extension → AT-SPI | extension → portal ScreenCast | Mutter IdleMonitor |
| KDE Wayland | KWin script → AT-SPI | KWin ScreenShot2 → portal | ext-idle-notify |
| Sway / Hyprland | compositor IPC → AT-SPI | `grim -o <output>` → portal | ext-idle-notify |
| Other Wayland | AT-SPI | portal | ext-idle-notify / logind |

Every chain ends in "none": tracking of title and time continues with the reason shown in Settings, and a desktop with no window source records nothing rather than "Unknown".

## Folders

| Path | What |
|---|---|
| `timetracker_linux/` | The platform layer (provider, services, backends, tray, notifications, UI sections) |
| `session-helper/` | Runs on the distro's `/usr/bin/python3`: portal ScreenCast (GStreamer) and AT-SPI |
| `gnome-extension/` | GNOME Shell extension source (one tree, `build.sh` emits GNOME 45+ and 42–44 builds) and its headless test |
| `kwin-script/` | KWin focus reporter (Plasma 5 and 6) |
| `packaging/` | `nfpm.yaml` (.deb + .rpm), `.desktop` file, install/remove scripts, tarball installer, repo publishing |
| `build/` | PyInstaller spec, AlmaLinux 8 build image, `build_linux.sh`, `smoke_test.sh` |
| `tests/` | pytest suite (unit + real-bus + real helper process) |

## Development

```bash
cd linux-desktop-app
python3 -m venv --system-site-packages .venv && . .venv/bin/activate
grep -vE '^(pyinstaller|opencv-python)==' ../python-desktop-app/requirements.txt > /tmp/req.txt
pip install -r /tmp/req.txt -r requirements-linux.txt -r requirements-dev.txt

python -m pytest tests -q                    # Linux layer (≈235 tests)
python -m timetracker_linux --doctor         # what this desktop supports, live
python -m timetracker_linux --self-test      # OCR, privacy filter, SQLCipher, keyring
python -m timetracker_linux                  # run the app from source

gnome-extension/tests/run_headless_test.sh .venv/bin/python   # real extension in a private headless GNOME Shell
```

Running from source on GNOME needs the extension in `~/.local/share/gnome-shell/extensions/timetracker@amzur.com` (from `gnome-extension/build.sh`) and your interpreter's real path in `~/.config/timetracker/extension-allowed-exe`, then one logout/login. Without it, window titles come from AT-SPI.

## Building packages

```bash
build/build_linux.sh            # in the AlmaLinux 8 container (podman or docker): .deb, .rpm, .tar.gz
build/build_linux.sh --smoke    # plus install/self-test/uninstall on Ubuntu, Debian, Fedora, Alma, openSUSE, Arch
```

Output in `dist/` with `SHA256SUMS`. The CI workflow `.github/workflows/linux-desktop.yml` runs the tests on every change and the package build on demand.
