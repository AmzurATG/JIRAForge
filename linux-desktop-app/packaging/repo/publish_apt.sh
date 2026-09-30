#!/usr/bin/env bash
# Build/refresh a signed APT repository (static files; host on any HTTPS bucket).
#
#   packaging/repo/publish_apt.sh <repo-dir> <gpg-key-id> dist/timetracker_*.deb
#
# Layout: <repo-dir>/dists/stable/{InRelease,Release,Release.gpg,main/binary-<arch>/Packages*}
#         <repo-dir>/pool/main/t/timetracker/*.deb
# Needs: dpkg-scanpackages (dpkg-dev), apt-ftparchive (apt-utils), gpg.
# Clients get the repo from the .deb postinstall (dist/repo/timetracker.list).
set -euo pipefail

REPO="$1"; KEY="$2"; shift 2
POOL="$REPO/pool/main/t/timetracker"
mkdir -p "$POOL"
cp "$@" "$POOL/"

cd "$REPO"
for arch in amd64 arm64; do
    dir="dists/stable/main/binary-$arch"
    mkdir -p "$dir"
    dpkg-scanpackages --arch "$arch" pool/ > "$dir/Packages"
    gzip -9kf "$dir/Packages"
    xz -9kf "$dir/Packages"
done

apt-ftparchive \
    -o APT::FTPArchive::Release::Origin=Amzur \
    -o APT::FTPArchive::Release::Label=TimeTracker \
    -o APT::FTPArchive::Release::Suite=stable \
    -o APT::FTPArchive::Release::Codename=stable \
    -o APT::FTPArchive::Release::Architectures="amd64 arm64" \
    -o APT::FTPArchive::Release::Components=main \
    release dists/stable > dists/stable/Release

gpg --batch --yes --local-user "$KEY" --clearsign -o dists/stable/InRelease dists/stable/Release
gpg --batch --yes --local-user "$KEY" --armor --detach-sign -o dists/stable/Release.gpg dists/stable/Release
echo "APT repository updated in $REPO"
