#!/bin/sh
# Runs after removal (.deb: remove | purge; .rpm: $1 = 0). Upgrades keep everything.
# Per-user data (~/.local/share/TimeTracker, keyring entries) is left alone:
# users remove it with "Remove my data and sign out" in Settings.
set -e
case "$1" in
    remove|purge|0)
        rm -rf /usr/share/gnome-shell/extensions/timetracker@amzur.com
        rm -f /run/timetracker-restart.list
        if [ "$1" = purge ] || [ "$1" = 0 ]; then
            rm -f /etc/apt/sources.list.d/timetracker.list /usr/share/keyrings/timetracker-archive-keyring.gpg \
                  /etc/yum.repos.d/timetracker.repo /etc/zypp/repos.d/timetracker.repo
        fi
        command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications || true
        ;;
esac
exit 0
