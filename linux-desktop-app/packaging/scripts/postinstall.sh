#!/bin/sh
# Runs after install and upgrade (.deb: "configure"; .rpm: $1 = 1 install, 2 upgrade).
set -e
. /opt/timetracker/share/scripts/lib.sh

install_gnome_extension
refresh_desktop_caches
install_update_repo
relaunch_stopped_instances

cat <<'EOF'
TimeTracker is installed. Start it from your applications menu (it will start
automatically at login from then on). On GNOME, log out and back in once so the
TimeTracker integration can load.
EOF
exit 0
