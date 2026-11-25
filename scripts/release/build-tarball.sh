#!/bin/bash
# Builds not-unreachable-<version>-linux-<arch>.tar.gz for this machine's architecture (the native
# modules, better-sqlite3 and @node-rs/argon2, are built for it), after `pnpm install` and `pnpm build`.
# The release workflow runs it on each architecture; the CI install job runs it to install from.
#
#   build-tarball.sh <version> <out dir> [--no-sbom]
set -euo pipefail

# Pinned, as every tool the release runs (threat model, T13).
readonly CDXGEN=@cyclonedx/cdxgen@12.9.3

(($# == 2 || $# == 3)) || {
  sed -n '6p' "$0" >&2
  exit 2
}
version="$1" out="$2" sbom=true
[[ "${3:-}" != --no-sbom ]] || sbom=false
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]] || { echo "error: \"$version\" is not a version such as 1.2.3" >&2; exit 1; }
case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64) arch=arm64 ;;
  *) echo "error: no release for $(uname -m)" >&2; exit 1 ;;
esac
ldd --version 2>&1 | grep -qiE 'glibc|gnu libc' || { echo "error: releases are built on glibc" >&2; exit 1; }

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
name="not-unreachable-$version-linux-$arch"
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT

cd "$repo"
pnpm --filter @not-unreachable/server deploy --prod "$work/release"
# The server reports its version from its package.json.
# shellcheck disable=SC2016 # JavaScript, not shell.
node -e 'const fs = require("node:fs"); const [file, version] = process.argv.slice(1);
  const manifest = JSON.parse(fs.readFileSync(file, "utf8")); manifest.version = version;
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);' "$work/release/package.json" "$version"
sbom_file=""
if "$sbom"; then
  # The SBOM describes what the tarball ships: release/, which holds production dependencies only
  # (--required-only would drop most of them, as cdxgen reads pnpm's deploy tree as optional).
  pnpm dlx "$CDXGEN" --type js --no-recurse --spec-version 1.6 \
    --output "$work/sbom.cdx.json" "$work/release"
  sbom_file="$work/sbom.cdx.json"
fi
"$repo/scripts/release/assemble-bundle.sh" "$work/release" deploy/mount-helper/dist \
  "$version" "$arch" "$work/$name" ${sbom_file:+"$sbom_file"}

mkdir -p "$out"
# Owned by root in the archive, in a stable order, so the tarball doesn't carry the builder's ids.
# pax, as the update helper reads ustar and pax headers only (GNU tar's default writes long
# node_modules paths as GNU entries); the pax headers leave out atime and ctime to stay stable.
tar --create --gzip --file "$out/$name.tar.gz" --directory "$work" --format=pax \
  --pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime \
  --owner=0 --group=0 --numeric-owner --sort=name "$name"
printf '%s\n' "$out/$name.tar.gz"
