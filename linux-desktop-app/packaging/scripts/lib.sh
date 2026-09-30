#!/bin/sh
# Shared helpers for the package scripts (.deb and .rpm). POSIX sh.

APP_DIR=/opt/timetracker
APP_BIN="$APP_DIR/TimeTracker"
EXT_UUID="timetracker@amzur.com"
EXT_SYSTEM_DIR="/usr/share/gnome-shell/extensions/$EXT_UUID"
RESTART_LIST=/run/timetracker-restart.list

# Install the GNOME Shell extension build that matches the installed GNOME.
install_gnome_extension() {
    command -v gnome-shell >/dev/null 2>&1 || { rm -rf "$EXT_SYSTEM_DIR"; return 0; }
    major=$(gnome-shell --version 2>/dev/null | sed -E 's/[^0-9]*([0-9]+).*/\1/')
    [ -n "$major" ] || return 0
    if [ "$major" -ge 45 ]; then variant=esm; elif [ "$major" -ge 42 ]; then variant=legacy; else return 0; fi
    rm -rf "$EXT_SYSTEM_DIR"
    mkdir -p "$(dirname "$EXT_SYSTEM_DIR")"
    cp -r "$APP_DIR/gnome-extension/$variant/$EXT_UUID" "$EXT_SYSTEM_DIR"
    chmod -R go-w "$EXT_SYSTEM_DIR"
}

refresh_desktop_caches() {
    command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications || true
    command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
    command -v kbuildsycoca6 >/dev/null 2>&1 && kbuildsycoca6 --noincremental >/dev/null 2>&1 || true
    command -v kbuildsycoca5 >/dev/null 2>&1 && kbuildsycoca5 --noincremental >/dev/null 2>&1 || true
}

# Add the signed update repository shipped with the package (if configured at build time).
install_update_repo() {
    if [ -s "$APP_DIR/share/repo/timetracker.list" ] && [ -d /etc/apt/sources.list.d ]; then
        install -m 0644 "$APP_DIR/share/repo/timetracker-archive-keyring.gpg" /usr/share/keyrings/timetracker-archive-keyring.gpg
        install -m 0644 "$APP_DIR/share/repo/timetracker.list" /etc/apt/sources.list.d/timetracker.list
    fi
    if [ -s "$APP_DIR/share/repo/timetracker.repo" ]; then
        for dir in /etc/yum.repos.d /etc/zypp/repos.d; do
            [ -d "$dir" ] && install -m 0644 "$APP_DIR/share/repo/timetracker.repo" "$dir/timetracker.repo"
        done
        [ -s "$APP_DIR/share/repo/RPM-GPG-KEY-timetracker" ] && command -v rpm >/dev/null 2>&1 && \
            rpm --import "$APP_DIR/share/repo/RPM-GPG-KEY-timetracker" 2>/dev/null || true
    fi
}

remove_update_repo() {
    rm -f /etc/apt/sources.list.d/timetracker.list /usr/share/keyrings/timetracker-archive-keyring.gpg \
          /etc/yum.repos.d/timetracker.repo /etc/zypp/repos.d/timetracker.repo
}

# Stop running instances gracefully (the app saves its session on SIGTERM) and
# remember who ran them, so postinst can relaunch them after an upgrade.
stop_running_instances() {
    remember="$1"
    : > "$RESTART_LIST.tmp" 2>/dev/null || remember=no
    for pid in $(pgrep -f "^$APP_BIN( |$)" 2>/dev/null); do
        if [ "$remember" = yes ]; then
            uid=$(stat -c %u "/proc/$pid" 2>/dev/null) || continue
            env_file="/proc/$pid/environ"
            vars=$(tr '\0' '\n' < "$env_file" 2>/dev/null | grep -E '^(DBUS_SESSION_BUS_ADDRESS|DISPLAY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR|XDG_CURRENT_DESKTOP|XDG_SESSION_TYPE|XDG_SESSION_ID|HOME|LANG)=' | tr '\n' ' ')
            echo "$uid $vars" >> "$RESTART_LIST.tmp"
        fi
        kill -TERM "$pid" 2>/dev/null || true
    done
    [ "$remember" = yes ] && mv -f "$RESTART_LIST.tmp" "$RESTART_LIST" 2>/dev/null
    # Up to 15 s for a clean save, then force.
    i=0
    while pgrep -f "^$APP_BIN( |$)" >/dev/null 2>&1 && [ $i -lt 30 ]; do sleep 0.5; i=$((i + 1)); done
    pkill -KILL -f "^$APP_BIN( |$)" 2>/dev/null || true
}

relaunch_stopped_instances() {
    [ -s "$RESTART_LIST" ] || return 0
    while read -r uid vars; do
        user=$(getent passwd "$uid" | cut -d: -f1)
        [ -n "$user" ] || continue
        # shellcheck disable=SC2086
        setsid runuser -u "$user" -- env $vars "$APP_BIN" --autostart >/dev/null 2>&1 < /dev/null &
    done < "$RESTART_LIST"
    rm -f "$RESTART_LIST"
}
