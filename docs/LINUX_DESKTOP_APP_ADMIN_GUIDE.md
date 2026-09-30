# TimeTracker for Linux: Deployment and Support Guide

**Audience:** IT administrators and support staff who install TimeTracker on employee Linux machines.
**App version:** matches the Windows release numbering (for example 1.4.13).

---

## 1. Supported systems

| Tier | Systems | What it means |
|---|---|---|
| **Supported** (tested every release) | Ubuntu 22.04, 24.04, 26.04 (GNOME); Linux Mint 22 (Cinnamon); Fedora (current, GNOME) | Full tracking: window titles, on-screen text, idle and lock detection |
| **Tested before major releases** | Kubuntu / Fedora KDE (Plasma 6), Debian 12/13, RHEL/Alma/Rocky 9–10, openSUSE Tumbleweed, Xubuntu, Pop!_OS | Same features; bugs fixed but not release-blocking |
| **Best effort** | Sway, Hyprland, labwc and other wlroots desktops, COSMIC, Arch (tarball), immutable distros (`--user` tarball) | Works through the same mechanisms; not release-gated |
| **Not supported** | Flatpak/Snap packaging, distributions without systemd or elogind, 32-bit systems | — |

The binary needs **glibc 2.28 or newer** (every distribution above) and **x86_64**.

## 2. Install

| Distribution family | Command |
|---|---|
| Ubuntu, Debian, Mint, Pop!_OS | `sudo apt install ./timetracker_<version>_amd64.deb` |
| Fedora, RHEL, Alma, Rocky | `sudo dnf install ./timetracker-<version>-1.x86_64.rpm` |
| openSUSE | `sudo zypper install ./timetracker-<version>-1.x86_64.rpm` |
| Anything else | `tar xzf timetracker-<version>-linux-x86_64.tar.gz && sudo ./timetracker-*/install.sh --system` |
| No root (immutable systems) | `./timetracker-*/install.sh --user` (installs to `~/.local/opt`, no automatic updates) |

Use `apt`/`dnf`/`zypper` rather than `dpkg -i` / `rpm -i`, so the recommended packages (PipeWire GStreamer plugin, portal, AT-SPI) are installed too.

What gets installed: the app in `/opt/timetracker`, the launcher entry `com.amzur.timetracker.desktop`, icons, the GNOME Shell extension `timetracker@amzur.com` (matching the installed GNOME version), and the KWin script `timetracker-focus`.

After installing, each user starts TimeTracker once from the applications menu. From then on it starts automatically at login (`~/.config/autostart/com.amzur.timetracker.desktop`). To start it for everyone at login, copy that file to `/etc/xdg/autostart/`.

## 3. What users see the first time

| Desktop | First run |
|---|---|
| X11 (Mint, Xfce, Ubuntu "on Xorg") | Nothing. |
| GNOME | A notification asking them to **log out and back in once** (GNOME loads new extensions only at login). Until then TimeTracker may ask to share the screen. |
| GNOME with extensions blocked by policy | A one-time screen-sharing dialog: select the monitors they work on and tick **Remember**. |
| KDE Plasma | Nothing. |
| Sway / Hyprland | Nothing (`grim` must be installed). |

Users may see a "screen is being shared" indicator on desktops that use the sharing fallback. It is shown only while tracking is active and disappears when they pause, lock or go idle.

**Privacy summary for users:** TimeTracker reads the text on the monitor that holds the active window, on the computer. The image is processed in memory and never saved or uploaded. Nothing is captured while the screen is locked. Email clients (Thunderbird, Evolution, Geary, KMail, Mailspring) and web mail are masked, the same as Outlook on Windows.

## 4. Policies and managed desktops

- **GNOME extension allow-listing.** If your policy locks `org.gnome.shell enabled-extensions` or sets `disable-user-extensions=true`, add `timetracker@amzur.com` to the allowed list. Without it, TimeTracker falls back to the screen-sharing portal (one prompt per user; the sharing indicator is visible).
- **The GNOME extension only serves the TimeTracker binary.** It checks the calling program's path (`/opt/timetracker/TimeTracker`) and refuses all others. It offers only the focused window and the focused monitor, at most one capture every 2 seconds, and nothing while the screen is locked.
- **KDE.** The installed `.desktop` file grants TimeTracker KWin's screenshot interface. Do not wrap the binary in a script: KWin checks the executable path.
- **Tray icon on vanilla GNOME** (Fedora, RHEL, Debian) needs the AppIndicator extension (`gnome-shell-extension-appindicator`). Without it TimeTracker still runs; users open it from the applications menu.
- **Keyring.** Credentials are stored in the Secret Service (GNOME Keyring, KWallet, KeePassXC). Without one, an encrypted file bound to the user account and `/etc/machine-id` is used instead.

## 5. Updates

If the package was built with the company update repository (see `linux-desktop-app/packaging/repo/`), installing it adds a signed APT/YUM repository. Updates then arrive through the normal system updater (`unattended-upgrades`, `dnf-automatic`, Software Updater). Running copies are stopped cleanly before the update and restarted in each user's session afterwards.

The app also checks the TimeTracker server for new versions and tells the user. A **mandatory** update pauses tracking until it is installed, the same as on Windows. `--user` tarball installs never update themselves; users download the new version.

## 6. Uninstall

- `sudo apt remove timetracker` / `sudo dnf remove timetracker` / `sudo /opt/timetracker/share/install.sh --uninstall`.
- Each user's local data is kept by design. Users remove it in **Settings → Linux desktop integration → Remove my data and sign out**. Manually: `rm -rf ~/.local/share/TimeTracker ~/.config/timetracker ~/.local/state/TimeTracker`, then `secret-tool clear service TimeTracker`.

## 7. Troubleshooting

Start with `timetracker --doctor` in a terminal (as the affected user, inside their desktop session). It prints the desktop, what is available and what TimeTracker will use, without changing anything:

```
live:
  window source : YES (loaded: gnome_extension, atspi)
  capture       : gnome_extension -> portal_screencast -> null
  idle clock    : 12.4 s via mutter
  screen locked : no
  tray host     : yes
```

| Symptom | Likely cause | Fix |
|---|---|---|
| `window source : NO` | Desktop has no supported window source | Check the desktop is in §1; on GNOME log out/in once so the extension loads |
| `extension : NOT_INSTALLED` or `DISABLED` on GNOME | New install not yet loaded, or blocked by policy | Log out and back in; allow `timetracker@amzur.com` (§4) |
| Screen text empty, Settings shows "screen text capture: unavailable – DENIED" | Screen sharing not allowed yet | Settings → **Allow screen access**, pick the monitors, tick Remember |
| No tray icon on Fedora/RHEL/Debian GNOME | No AppIndicator extension | Install `gnome-shell-extension-appindicator`, or use the applications menu |
| Idle time wrong on KDE Wayland | Plasma older than 6 (no `ext-idle-notify`) | Upgrade Plasma, or use the X11 session |
| Nothing works after an upgrade on GNOME | GNOME still runs the previous extension version | Log out and back in |

`timetracker --self-test` checks the installation itself (OCR models, privacy filter, database encryption, keyring) and needs no desktop.

Logs: `~/.local/share/TimeTracker/logs/`. Window titles and on-screen text are not written to logs at the default level.
