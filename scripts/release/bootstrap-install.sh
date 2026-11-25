#!/bin/bash
# Installs or upgrades NotUnreachable from its GitHub Releases, where the Release workflow attaches
# this script as install.sh (docs/install.md). It downloads SHA256SUMS and its signature,
# SHA256SUMS.sig, and stops unless the signature verifies with a key pinned below
# (docs/design/deployment.md, "Release signing"). Then it downloads the tarball for this machine's
# architecture, stops unless its checksum matches the signed SHA256SUMS, unpacks it into a temporary
# folder and runs the tarball's own install.sh with every option it doesn't take itself.
#
# It can't vouch for itself: docs/install.md shows how to check this script by hand against the
# release's signed SHA256SUMS.
#
#   curl -fsSL https://github.com/przemczan/not-unreachable/releases/latest/download/install.sh | sudo bash
#   curl -fsSL …/install.sh | sudo bash -s -- [--version 1.2.3] [install.sh's options]
set -euo pipefail

RELEASES_URL=https://github.com/przemczan/not-unreachable/releases
# The update helper's caps (deploy/mount-helper/src/release-verify.mts; deployment.md, "Updating from
# Settings").
MAX_SIGNATURE_FILE_BYTES=4096
MAX_CHECKSUMS_FILE_BYTES=16384
MAX_TARBALL_BYTES=268435456
MAX_SIGNATURE_LINES=4

# The release signing public keys this installer trusts: deploy/keys/release-signing/<key id>.pem,
# inline, since it runs before Node may be installed and checks with openssl. A test checks they are
# the repository's files. Prints the key for a key id, or fails for one it doesn't trust.
trusted_key() {
  case "$1" in
    # The active key, which signs every release.
    5215940524b38b8b)
      printf '%s\n' '-----BEGIN PUBLIC KEY-----' 'MCowBQYDK2VwAyEASR0hb5IxGr2JVKNNw0xnXvNmrK7XyLgTJmaW12efUAU=' '-----END PUBLIC KEY-----'
      ;;
    # The backup key, kept offline for when the active one is lost or leaked.
    ac8f1017437bcf2e)
      printf '%s\n' '-----BEGIN PUBLIC KEY-----' 'MCowBQYDK2VwAyEAQBKHauils+vfg7vLDb35N9Jl7Bv1a8WSGa6huIhLggA=' '-----END PUBLIC KEY-----'
      ;;
    *) return 1 ;;
  esac
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: curl -fsSL https://github.com/przemczan/not-unreachable/releases/latest/download/install.sh | sudo bash -s -- [options]

Downloads a NotUnreachable release for this machine, checks the signature of the release's
SHA256SUMS and the tarball against it, and installs it, or upgrades an existing install to it.

Options:
  --version VERSION   The release to install, such as 1.2.3 (the latest when not given).
  -h, --help          Show this help.

Every other option goes to the release's own install.sh, such as --public-origin URL,
--allow-folder PATH (repeatable), --yes, or --uninstall [--purge]; see docs/install.md.
EOF
}

# Prints the release's architecture for `uname -m`'s answer.
release_arch() {
  case "$1" in
    x86_64 | amd64) printf 'x64' ;;
    aarch64 | arm64) printf 'arm64' ;;
    *) return 1 ;;
  esac
}

valid_version() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; }

# Downloads the URL to the file, over HTTPS only, and stops on one over the cap in bytes. curl refuses
# a Content-Length over it before downloading; a response without one older curl downloads whole, so
# its size is checked once it is in.
download() {
  local url="$1" file="$2" max_bytes="$3" status=0
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --retry 3 \
    --max-filesize "$max_bytes" --output "$file" "$url" || status=$?
  # 63: curl's "maximum file size exceeded".
  ((status != 63)) || die "${file##*/} is over $max_bytes bytes: not installing anything."
  ((status == 0)) || return "$status"
  (($(wc -c <"$file") <= max_bytes)) || die "${file##*/} is over $max_bytes bytes: not installing anything."
}

# From `openssl version`, such as "OpenSSL 3.0.13 30 Jan 2024": 3.0 or later verifies Ed25519 over a
# whole file (pkeyutl -rawin).
check_openssl() {
  local major
  [[ "$1" =~ ^OpenSSL\ ([0-9]+)\. ]] || die "openssl 3.0 or later is needed to check the release's signature; \"$1\" is not OpenSSL."
  major="${BASH_REMATCH[1]}"
  ((10#$major >= 3)) || die "openssl 3.0 or later is needed to check the release's signature; this is \"$1\"."
}

# Verifies SHA256SUMS against SHA256SUMS.sig (deployment.md, "Release signing"): 1 to 4 lines of
# `ed25519 <key id> <base64 signature>`, at most 4 KiB. Lines by a key it doesn't trust are skipped;
# it goes on only when at least one trusted line verifies and none fails. Anything else stops it.
verify_signature() {
  local checksums="$1" signature_file="$2" work="$3" size line lines=0 verified=0 signature key_id encoded
  local -A seen=()
  size=$(wc -c <"$signature_file")
  ((size > 0 && size <= MAX_SIGNATURE_FILE_BYTES)) || die "SHA256SUMS.sig is malformed (empty or over 4 KiB): not installing anything."
  [[ -z "$(tail -c 1 -- "$signature_file")" ]] || die "SHA256SUMS.sig is malformed (no final newline): not installing anything."
  while IFS= read -r line; do
    lines=$((lines + 1))
    ((lines <= MAX_SIGNATURE_LINES)) || die "SHA256SUMS.sig is malformed (more than $MAX_SIGNATURE_LINES lines): not installing anything."
    [[ "$line" =~ ^ed25519\ ([0-9a-f]{16})\ ([A-Za-z0-9+/]{86}==)$ ]] ||
      die "SHA256SUMS.sig is malformed (line $lines): not installing anything."
    key_id="${BASH_REMATCH[1]}" encoded="${BASH_REMATCH[2]}"
    [[ -z "${seen[$key_id]:-}" ]] || die "SHA256SUMS.sig is malformed (the key $key_id signs twice): not installing anything."
    seen[$key_id]=1
    trusted_key "$key_id" >"$work/key.pem" || continue
    signature="$work/signature-$lines"
    printf '%s' "$encoded" | base64 --decode >"$signature" 2>/dev/null ||
      die "SHA256SUMS.sig is malformed (line $lines): not installing anything."
    [[ "$(wc -c <"$signature")" -eq 64 ]] || die "SHA256SUMS.sig is malformed (line $lines): not installing anything."
    openssl pkeyutl -verify -pubin -inkey "$work/key.pem" -rawin -in "$checksums" -sigfile "$signature" >/dev/null 2>&1 ||
      die "the signature of SHA256SUMS by key $key_id doesn't verify: the release's files were changed. Not installing anything."
    verified=$((verified + 1))
  done <"$signature_file"
  ((verified > 0)) ||
    die "SHA256SUMS.sig has no signature by a key this installer trusts: not installing anything. If the release is genuine, this installer is too old; download the latest one."
  printf '==> SHA256SUMS is signed by a trusted key\n'
}

# Downloads SHA256SUMS and SHA256SUMS.sig from a release's download URL into the folder and checks
# the signature, before anything reads SHA256SUMS.
download_signed_checksums() {
  local base="$1" folder="$2" what="$3"
  mkdir -p -- "$folder"
  download "$base/SHA256SUMS" "$folder/SHA256SUMS" "$MAX_CHECKSUMS_FILE_BYTES" || die "could not download SHA256SUMS of $what."
  download "$base/SHA256SUMS.sig" "$folder/SHA256SUMS.sig" "$MAX_SIGNATURE_FILE_BYTES" ||
    die "could not download SHA256SUMS.sig of $what. A release from before releases were signed has none, and can't be installed with this script: install it by hand (docs/install.md, \"Download and verify by hand\")."
  verify_signature "$folder/SHA256SUMS" "$folder/SHA256SUMS.sig" "$folder"
}

# Prints the version of the tarball for the architecture that SHA256SUMS lists.
version_in_checksums() {
  local checksums="$1" arch="$2" name version="" found=0
  while read -r _ name; do
    name="${name#\*}"
    if [[ "$name" =~ ^not-unreachable-(.+)-linux-"$arch"\.tar\.gz$ ]]; then
      version="${BASH_REMATCH[1]}"
      found=$((found + 1))
    fi
  done <"$checksums"
  if ((found != 1)) || ! valid_version "$version"; then
    return 1
  fi
  printf '%s' "$version"
}

# Prints the SHA-256 that SHA256SUMS lists for the file name.
expected_checksum() {
  local checksums="$1" file="$2" sum name
  while read -r sum name; do
    if [[ "${name#\*}" == "$file" ]]; then
      printf '%s' "$sum"
      return 0
    fi
  done <"$checksums"
  return 1
}

verify_checksum() {
  local tarball="$1" expected="$2" actual
  actual=$(sha256sum <"$tarball")
  actual="${actual%% *}"
  [[ "$actual" == "$expected" ]] ||
    die "$(basename "$tarball") doesn't match SHA256SUMS (expected $expected, got $actual): not installing it."
}

# Runs the tarball's installer. Run as `curl … | sudo bash`, this script's stdin is the pipe it is
# read from, so the installer asks its questions on the terminal instead, when there is one, and
# otherwise reads nothing (it then asks for the answers as options). It runs through bash, as the
# temporary folder may be on a noexec /tmp.
run_installer() {
  local installer="$1"
  shift
  if [[ -t 0 ]]; then
    bash "$installer" "$@"
  elif { true </dev/tty; } 2>/dev/null; then
    bash "$installer" "$@" </dev/tty
  else
    bash "$installer" "$@" </dev/null
  fi
}

main() {
  local version="" machine arch work checksums name base
  local -a installer_options=()
  while (($# > 0)); do
    case "$1" in
      --version) (($# >= 2)) || die "--version needs a version such as 1.2.3."; version="$2"; shift ;;
      --version=*) version="${1#*=}" ;;
      -h | --help) usage; return 0 ;;
      *) installer_options+=("$1") ;;
    esac
    shift
  done
  version="${version#v}"
  [[ -z "$version" ]] || valid_version "$version" || die "\"$version\" is not a version such as 1.2.3."

  local tool
  for tool in curl tar sha256sum mktemp uname openssl base64; do
    command -v "$tool" >/dev/null || die "$tool is needed; install it and try again."
  done
  check_openssl "$(openssl version)"
  machine=$(uname -m)
  arch=$(release_arch "$machine") || die "there is no NotUnreachable release for $machine (only x86_64 and aarch64)."

  work=$(mktemp -d)
  # shellcheck disable=SC2064 # Expanded now: $work is local to main.
  trap "rm -rf -- '$work'" EXIT

  if [[ -z "$version" ]]; then
    download_signed_checksums "$RELEASES_URL/latest/download" "$work/latest" "the latest release"
    version=$(version_in_checksums "$work/latest/SHA256SUMS" "$arch") ||
      die "the latest release has no tarball for linux-$arch."
  fi
  # The tarball comes from the version's own release, so a release published meanwhile can't mix in.
  base="$RELEASES_URL/download/v$version"
  name="not-unreachable-$version-linux-$arch"
  download_signed_checksums "$base" "$work/checksums" "release $version"
  checksums="$work/checksums/SHA256SUMS"
  local expected
  expected=$(expected_checksum "$checksums" "$name.tar.gz") || die "release $version has no tarball for linux-$arch."

  printf '==> Downloading NotUnreachable %s for linux-%s\n' "$version" "$arch"
  download "$base/$name.tar.gz" "$work/$name.tar.gz" "$MAX_TARBALL_BYTES" || die "could not download $name.tar.gz."
  verify_checksum "$work/$name.tar.gz" "$expected"
  printf '==> %s.tar.gz matches SHA256SUMS\n' "$name"
  tar --extract --gzip --file "$work/$name.tar.gz" --directory "$work" --no-same-owner
  [[ -f "$work/$name/install.sh" ]] || die "$name.tar.gz has no install.sh."

  run_installer "$work/$name/install.sh" "${installer_options[@]}"
}

# Last, so that a download cut short runs nothing; skipped when the tests source this file.
if ! (return 0 2>/dev/null); then
  main "$@"
fi
