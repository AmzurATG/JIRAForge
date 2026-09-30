#!/usr/bin/env bash
# Build/refresh a signed YUM/DNF/zypper repository (static files).
#
#   packaging/repo/publish_rpm.sh <repo-dir> <gpg-key-id> dist/timetracker-*.rpm
#
# Needs: rpmsign (rpm-sign), createrepo_c, gpg. Signs each package and the
# repository metadata (repo_gpgcheck=1 in the client .repo file).
set -euo pipefail

REPO="$1"; KEY="$2"; shift 2
mkdir -p "$REPO/packages"
for rpm_file in "$@"; do
    cp "$rpm_file" "$REPO/packages/"
    rpmsign --define "_gpg_name $KEY" --addsign "$REPO/packages/$(basename "$rpm_file")"
done
createrepo_c --update "$REPO"
gpg --batch --yes --local-user "$KEY" --armor --detach-sign -o "$REPO/repodata/repomd.xml.asc" "$REPO/repodata/repomd.xml"
echo "RPM repository updated in $REPO"
