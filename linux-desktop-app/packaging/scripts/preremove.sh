#!/bin/sh
# Runs before removal and before an upgrade replaces the files.
#   .deb: $1 = remove | upgrade | deconfigure     .rpm: $1 = 0 remove, >= 1 upgrade
set -e
. /opt/timetracker/share/scripts/lib.sh

case "$1" in
    upgrade|1|2) stop_running_instances yes ;;   # relaunched by the new postinstall
    *)           stop_running_instances no ;;
esac
exit 0
