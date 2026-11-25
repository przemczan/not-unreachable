#!/bin/bash
# Lays out the release tarball's folder (docs/design/stack.md, "Release artefact"):
#
#   install.sh  release/  deploy/  docs/install.md  VERSION  ARCH  [sbom.cdx.json]
#
# release/ is the server's `pnpm deploy --prod` folder, plus release-signing-keys/: the public keys
# this release trusts (deploy/keys/release-signing/); deploy/ holds what install.sh installs.
# build-tarball.sh calls it after the build; the install tests call it with a stand-in release/.
#
#   assemble-bundle.sh <release dir> <helpers dir> <version> <x64|arm64> <out dir> [sbom.cdx.json]
#
# <helpers dir> is deploy/mount-helper/dist: the mount, folder and update helpers and the modules they
# import.
set -euo pipefail

(($# == 5 || $# == 6)) || {
  sed -n '10p' "$0" >&2
  exit 2
}
release_dir="$1" helpers="$2" version="$3" arch="$4" out="$5" sbom="${6:-}"
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)

[[ -f "$release_dir/dist/main.js" ]] || { echo "error: $release_dir/dist/main.js is missing" >&2; exit 1; }
helper_files=(mount-helper.mjs request-file.mjs folder-access.mjs folder-helper.mjs update-helper.mjs release-verify.mjs release-archive.mjs)
signing_keys=("$repo"/deploy/keys/release-signing/*.pem)
for file in "${helper_files[@]}"; do
  [[ -f "$helpers/$file" ]] || { echo "error: $helpers/$file is missing; build the helpers first" >&2; exit 1; }
done
[[ "$arch" == x64 || "$arch" == arm64 ]] || { echo "error: the architecture must be x64 or arm64" >&2; exit 1; }
[[ -f "${signing_keys[0]}" ]] || { echo "error: deploy/keys/release-signing/ holds no key" >&2; exit 1; }
[[ ! -e "$out" ]] || { echo "error: $out exists already" >&2; exit 1; }

umask 022
mkdir -p "$out/deploy" "$out/docs"
cp -R -- "$release_dir" "$out/release"
mkdir "$out/release/release-signing-keys"
install -m 0644 "${signing_keys[@]}" "$out/release/release-signing-keys/"
install -m 0755 "$repo/deploy/install.sh" "$out/install.sh"
for folder in bin keys polkit proxy systemd sysusers tmpfiles; do
  cp -R -- "$repo/deploy/$folder" "$out/deploy/$folder"
done
for file in "${helper_files[@]}"; do
  install -m 0644 "$helpers/$file" "$out/deploy/$file"
done
install -m 0644 "$repo/docs/install.md" "$out/docs/install.md"
printf '%s\n' "$version" >"$out/VERSION"
printf '%s\n' "$arch" >"$out/ARCH"
[[ -z "$sbom" ]] || install -m 0644 "$sbom" "$out/sbom.cdx.json"
