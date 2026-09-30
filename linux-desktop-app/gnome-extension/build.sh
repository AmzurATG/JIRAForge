#!/usr/bin/env bash
# Build both GNOME Shell extension variants from src/.
#   dist/esm/timetracker@amzur.com     GNOME 45+
#   dist/legacy/timetracker@amzur.com  GNOME 42-44
# Add a GNOME version to ESM_VERSIONS only after tests/run_headless_test.sh passes on it.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
UUID="timetracker@amzur.com"
VERSION="${EXTENSION_VERSION:-1}"
ESM_VERSIONS='"45", "46", "47", "48", "49", "50"'
LEGACY_VERSIONS='"42", "43", "44"'
OUT="${1:-$HERE/dist}"

write_variant() {
    local name="$1" versions="$2" header="$3" footer="$4"
    local dir="$OUT/$name/$UUID"
    rm -rf "$dir"
    mkdir -p "$dir"
    cat "$HERE/src/$header" "$HERE/src/core.js" "$HERE/src/$footer" > "$dir/extension.js"
    cat > "$dir/metadata.json" <<EOF
{
  "uuid": "$UUID",
  "name": "TimeTracker Integration",
  "description": "Lets the TimeTracker app read the active window and capture the active monitor for on-device text recognition. Only the installed TimeTracker app can use it. Nothing is captured while the screen is locked.",
  "shell-version": [$versions],
  "version": $VERSION,
  "url": "https://timetracker-forge.amzur.com"
}
EOF
    echo "built $dir"
}

write_variant esm "$ESM_VERSIONS" header-esm.js footer-esm.js
write_variant legacy "$LEGACY_VERSIONS" header-legacy.js footer-legacy.js
