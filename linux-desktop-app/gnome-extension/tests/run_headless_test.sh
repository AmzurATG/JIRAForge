#!/usr/bin/env bash
# Run the extension against a real, isolated, headless GNOME Shell.
#
# Everything is private to this run: its own D-Bus session, XDG data/config/
# runtime dirs and a virtual monitor. The user's desktop session is untouched.
#
#   gnome-extension/tests/run_headless_test.sh [python]
#
# Requires: gnome-shell (>= 45 for the esm build), dbus-run-session, zenity.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
EXT_ROOT="$(dirname "$HERE")"
LINUX_ROOT="$(dirname "$EXT_ROOT")"
PYTHON="${1:-python3}"
PYTHON_REAL="$(readlink -f "$(command -v "$PYTHON")")"
UUID="timetracker@amzur.com"

WORK="$(mktemp -d -t tt-gnome-headless-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/data/gnome-shell/extensions" "$WORK/config/timetracker" "$WORK/run" "$WORK/home"
chmod 700 "$WORK/run"

SHELL_MAJOR="$(gnome-shell --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')"
VARIANT=esm
[ "$SHELL_MAJOR" -lt 45 ] && VARIANT=legacy
"$EXT_ROOT/build.sh" "$WORK/build" >/dev/null
cp -r "$WORK/build/$VARIANT/$UUID" "$WORK/data/gnome-shell/extensions/"
# Per-user install: allow the test interpreter (the real app uses /opt/timetracker/TimeTracker).
echo "$PYTHON_REAL" > "$WORK/config/timetracker/extension-allowed-exe"

export HOME="$WORK/home" XDG_DATA_HOME="$WORK/data" XDG_CONFIG_HOME="$WORK/config" \
       XDG_RUNTIME_DIR="$WORK/run" XDG_CACHE_HOME="$WORK/home/.cache" \
       TT_ALLOW_FILE="$WORK/config/timetracker/extension-allowed-exe" \
       TT_LINUX_ROOT="$LINUX_ROOT" TT_WAYLAND_DISPLAY="tt-headless-0" \
       GSETTINGS_BACKEND=keyfile
unset DISPLAY WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS

echo "GNOME Shell $SHELL_MAJOR, variant $VARIANT, python $PYTHON_REAL"
dbus-run-session -- bash -c '
  set -e
  gsettings set org.gnome.shell enabled-extensions "[\"timetracker@amzur.com\"]"
  gsettings set org.gnome.shell disable-user-extensions false
  gnome-shell --headless --wayland --no-x11 --virtual-monitor 1280x800 \
      --wayland-display "$TT_WAYLAND_DISPLAY" > "$XDG_RUNTIME_DIR/shell.log" 2>&1 &
  SHELL_PID=$!
  status=0
  "'"$PYTHON"'" "'"$HERE"'/headless_check.py" || status=$?
  kill $SHELL_PID 2>/dev/null || true
  wait $SHELL_PID 2>/dev/null || true
  if [ $status -ne 0 ]; then
    echo "---- gnome-shell log (tail) ----"; tail -40 "$XDG_RUNTIME_DIR/shell.log"
  fi
  exit $status
'
