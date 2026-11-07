#!/usr/bin/env bash
# Install this app for the current user, from a published release, and give it an app-menu entry.
#
#   scripts/install-linux-local.sh            # the version in package.json
#   scripts/install-linux-local.sh 0.7.6      # a specific release
#
# Why the tarball and not the `.deb` or the AppImage: this workstation is an immutable Fedora
# derivative, where a Debian package has nowhere to go and the AppImage bundler is a best-effort step
# that some builds skip. The tarball is the same binary and the same bundled runtime, unpacked into
# `~/.local/opt` instead of `/usr` — no root, no layering, and removing the folder removes the app.
#
# The desktop entry is what makes it launchable from the app menu, so this script writes it on every
# run rather than asking anyone to remember: an update that leaves a stale `Exec=` line is an update
# that quietly stops opening.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tag=${1:-$(node -p "require('${repo_root}/package.json').version")}
version=${tag#v}

app_dir="${HOME}/.local/opt/HardlyTracking"
bin="${app_dir}/hardlytracking"
icon_dir="${HOME}/.local/share/icons/hicolor/256x256/apps"
desktop_dir="${HOME}/.local/share/applications"
work=$(mktemp -d)
trap 'rm -rf "${work}"' EXIT

echo "Installing HardlyTracking ${version} into ${app_dir}"
archive="HardlyTracking_${version}_linux-x86_64.tar.gz"
gh release download "v${version}" --repo hardlysleeping/hardlytracking --pattern "${archive}" --dir "${work}" --clobber

# Unpack beside the old install and swap at the end: a failed download must never leave the app menu
# pointing at a half-written folder.
mkdir -p "${work}/unpacked"
tar -C "${work}/unpacked" -xzf "${work}/${archive}"
test -x "${work}/unpacked/HardlyTracking/hardlytracking" || { echo "the tarball has no binary" >&2; exit 1; }
test -f "${work}/unpacked/HardlyTracking/runtime/runner.jar" || { echo "the tarball has no extension host" >&2; exit 1; }

rm -rf "${app_dir}"
mkdir -p "${app_dir}"
cp -a "${work}/unpacked/HardlyTracking/." "${app_dir}/"

mkdir -p "${icon_dir}" "${desktop_dir}" "${HOME}/.local/bin"
cp "${repo_root}/src-tauri/icons/128x128@2x.png" "${icon_dir}/hardlytracking.png"
ln -sf "${bin}" "${HOME}/.local/bin/hardlytracking"

cat > "${desktop_dir}/hardlytracking.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=HardlyTracking
GenericName=Comic Reader
Comment=Read your own comics, and the sources you added yourself
Exec=${bin} %U
Icon=hardlytracking
Terminal=false
Categories=Graphics;Viewer;
Keywords=comic;manga;cbz;cbr;reader;
StartupNotify=true
StartupWMClass=HardlyTracking
DESKTOP

update-desktop-database "${desktop_dir}" 2>/dev/null || true

echo "Installed:"
echo "  app      ${bin}"
echo "  menu     ${desktop_dir}/hardlytracking.desktop"
echo "  command  hardlytracking"
"${bin}" --version 2>/dev/null || true
