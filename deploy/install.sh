#!/bin/bash
# NotUnreachable's installer (docs/install.md; the layout is docs/design/deployment.md's). Run it as
# root from the unpacked, verified release tarball:
#
#   sudo ./install.sh [--public-origin https://files.example.com] [--allow-folder /srv/media]... [--uid 2000] [--yes]
#   sudo ./install.sh --uninstall [--purge]
#   ./install.sh --apply-update     (run by the update helper's apply unit, as root)
#
# A first run installs; a run from a newer tarball upgrades (the new release next to the old one,
# `current` switched, the service restarted); config, the master key and data are never overwritten.
# Each release keeps a copy of this script in /opt/not-unreachable/<version>/installer/, which a
# rollback runs to put that release's system files back.
# DESTDIR=<dir> lays the files out under <dir> instead, without packages, users, ownership or systemd:
# the tests in deploy/install/ use it, with DESTDIR_NODE=<node> where the host's node isn't /usr/bin/node.
set -euo pipefail
# Without it, a failing command inside $(...), such as install_release's cp, would go unnoticed.
shopt -s inherit_errexit nullglob

PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 022

readonly SERVICE_USER=not-unreachable
readonly SERVICE_UNIT=not-unreachable.service
readonly BACKUP_UNIT=not-unreachable-backup.service
readonly BACKUP_TIMER=not-unreachable-backup.timer
readonly MOUNT_UNIT_TEMPLATE='not-unreachable-mount@.service'
readonly ALLOW_FOLDER_UNIT=not-unreachable-allow-folder.service
readonly UPDATE_UNIT=not-unreachable-update.service
readonly UPDATE_APPLY_UNIT=not-unreachable-update-apply.service
readonly NODE_MAJOR=24
readonly NODE_MIN_MINOR=11
readonly MIN_SYSTEMD=252
readonly MAX_EXPOSURE=2.0
readonly SECURITY_THRESHOLD=20 # systemd-analyze's threshold is the exposure times ten
# The folder helper runs as root, which costs it 0.4 alone; the rest of its sandbox is tighter than
# the service's (one capability, no network, its own namespace), so it scores 1.1 on systemd 255.
# 1.5 leaves room for other systemd versions weighing it differently, and still fails on a lost setting.
# The update helper's verify unit has the same sandbox, so the same limit.
readonly HELPER_MAX_EXPOSURE=1.5
readonly HELPER_SECURITY_THRESHOLD=15
# The update helper's apply unit needs an upgrade's rights (the capabilities an install uses, writes to
# the system folders, loopback), so it is held to 3.0 (deployment.md, "Updating from Settings").
readonly APPLY_MAX_EXPOSURE=3.0
readonly APPLY_SECURITY_THRESHOLD=30
readonly MASTER_KEY_BYTES=32
# The service user's UID and GID on a first install (docs/install.md, "The service user's ID"). An ID
# may be 1 to 60000: systemd keeps the IDs above for itself (homed's and DynamicUser='s), and 65534
# is nobody.
readonly DEFAULT_SERVICE_ID=2000
readonly MAX_SERVICE_ID=60000

DESTDIR="${DESTDIR:-}"

# Paths on the target system (deployment.md, "Config, secrets and data").
readonly OPT_DIR=/opt/not-unreachable
readonly CLI_PATH=/usr/local/bin/not-unreachable
readonly HELPER_DIR=/usr/lib/not-unreachable
readonly HELPER_PATH=$HELPER_DIR/mount-helper.mjs
# The mount, folder and update helpers and the modules they import, as built by deploy/mount-helper.
readonly HELPER_FILES=(mount-helper.mjs request-file.mjs folder-access.mjs folder-helper.mjs update-helper.mjs
  release-verify.mjs release-archive.mjs)
readonly CONFIG_DIR=/etc/not-unreachable
readonly CONFIG_FILE=$CONFIG_DIR/config.env
readonly CREDENTIALS_DIR=$CONFIG_DIR/credentials
readonly MASTER_KEY_FILE=$CREDENTIALS_DIR/master.key
readonly DATA_DIR=/var/lib/not-unreachable
readonly MOUNTS_PARENT=/srv/not-unreachable
readonly MOUNTS_DIR=$MOUNTS_PARENT/mounts
readonly HELPER_RUN_DIR=/run/not-unreachable-mount
readonly SERVICE_RUN_DIR=/run/not-unreachable
readonly UNIT_DIR=/etc/systemd/system
readonly DROP_IN_DIR=$UNIT_DIR/$SERVICE_UNIT.d
readonly POLKIT_RULE=/etc/polkit-1/rules.d/50-not-unreachable.rules
readonly FOLDER_RULE_NAME=51-not-unreachable-allow-folder.rules
# The allow-folder rule is active only while ALLOW_FOLDERS_FROM_UI=true; the CLI wrapper's
# allow-folders-from-ui copies it from its source next to the helpers.
readonly FOLDER_RULE=/etc/polkit-1/rules.d/$FOLDER_RULE_NAME
readonly FOLDER_RULE_SOURCE=$HELPER_DIR/$FOLDER_RULE_NAME
# The same for the update rule and UPDATE_FROM_UI (update-from-ui).
readonly UPDATE_RULE_NAME=52-not-unreachable-update.rules
readonly UPDATE_RULE=/etc/polkit-1/rules.d/$UPDATE_RULE_NAME
readonly UPDATE_RULE_SOURCE=$HELPER_DIR/$UPDATE_RULE_NAME
readonly POLKIT_RULES=(50-not-unreachable.rules "$FOLDER_RULE_NAME" "$UPDATE_RULE_NAME")
# The update units' state (StateDirectory=): the status the service reads, and the root-only work folder
# with the lock and the staged release.
readonly UPDATE_STATE_DIR=/var/lib/not-unreachable-update
readonly UPDATE_WORK_DIR=$UPDATE_STATE_DIR/work
readonly UPDATE_STATUS_FILE=$UPDATE_STATE_DIR/status.json
# Where an install over SSH puts the runtime drop-ins that hold updates from Settings while it runs.
readonly RUNTIME_UNIT_DIR=/run/systemd/system
readonly HOLD_DROP_IN=50-install-running.conf
# Inside each release: its own installer, for a rollback, and the signing keys it trusts.
readonly INSTALLER_DIR_NAME=installer
readonly TRUSTED_KEYS_DIR_NAME=release-signing-keys
readonly NODE=/usr/bin/node
readonly SYSUSERS_FILE=/usr/lib/sysusers.d/not-unreachable.conf
readonly TMPFILES_FILE=/usr/lib/tmpfiles.d/not-unreachable.conf
readonly UNITS=("$SERVICE_UNIT" "$BACKUP_UNIT" "$BACKUP_TIMER" "$MOUNT_UNIT_TEMPLATE" "$ALLOW_FOLDER_UNIT" "$UPDATE_UNIT"
  "$UPDATE_APPLY_UNIT")

# ---------------------------------------------------------------------------------------------------
# Output

if [[ -t 1 ]]; then
  readonly BOLD=$'\e[1m' RED=$'\e[31m' YELLOW=$'\e[33m' RESET=$'\e[0m'
else
  readonly BOLD='' RED='' YELLOW='' RESET=''
fi

step() { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
warn() { printf '%swarning:%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
# --apply-update's checks before it changes anything set it to 3 (needs-installer).
DIE_STATUS=1
die() {
  printf '%serror:%s %s\n' "$RED" "$RESET" "$*" >&2
  exit "$DIE_STATUS"
}

contains() {
  local wanted="$1" item
  shift
  for item in "$@"; do
    [[ "$item" == "$wanted" ]] && return 0
  done
  return 1
}

# A path on the target system, under DESTDIR when there is one.
target() { printf '%s%s' "$DESTDIR" "$1"; }
in_destdir() { [[ -n "$DESTDIR" ]]; }

# ---------------------------------------------------------------------------------------------------
# Preflight checks. Each takes what it checks as arguments, so the tests can feed it any host.

# Prints the package manager (apt or dnf) for a supported distribution, from an os-release file.
check_distribution() {
  local os_release="$1" ID="" VERSION_ID="" PRETTY_NAME=""
  [[ -r "$os_release" ]] || die "cannot read $os_release: is this a systemd-based Linux distribution?"
  # shellcheck disable=SC1090 # os-release is a shell-compatible key=value file by specification.
  ID=$(. "$os_release" && printf '%s' "${ID:-}")
  # shellcheck disable=SC1090
  VERSION_ID=$(. "$os_release" && printf '%s' "${VERSION_ID:-}")
  # shellcheck disable=SC1090
  PRETTY_NAME=$(. "$os_release" && printf '%s' "${PRETTY_NAME:-$ID $VERSION_ID}")

  local minimum manager
  case "$ID" in
    debian) minimum=12 manager=apt ;;
    ubuntu) minimum=24.04 manager=apt ;;
    fedora) minimum=40 manager=dnf ;;
    rhel | almalinux | rocky) minimum=9 manager=dnf ;;
    *) die "$PRETTY_NAME is not supported: install on Debian 12+, Ubuntu 24.04+, Fedora 40+ or RHEL, AlmaLinux or Rocky Linux 9+." ;;
  esac
  version_at_least "$VERSION_ID" "$minimum" ||
    die "$PRETTY_NAME is too old: this needs $ID $minimum or newer."
  printf '%s' "$manager"
}

# Whether dotted version $1 is at least $2 (numerically, part by part).
version_at_least() {
  local -a have want
  IFS=. read -r -a have <<<"$1"
  IFS=. read -r -a want <<<"$2"
  local index
  for index in 0 1 2; do
    local a="${have[index]:-0}" b="${want[index]:-0}"
    [[ "$a" =~ ^[0-9]+$ ]] || return 1
    ((10#$a > 10#$b)) && return 0
    ((10#$a < 10#$b)) && return 1
  done
  return 0
}

# From `systemctl --version`'s first line, such as "systemd 252 (252.30-1~deb12u2)".
check_systemd_version() {
  local first_line="$1" version
  version=$(awk '{ print $2 }' <<<"$first_line")
  [[ "$version" =~ ^[0-9]+$ ]] || die "cannot tell the systemd version from \"$first_line\"."
  ((version >= MIN_SYSTEMD)) || die "systemd $version is too old: this needs systemd $MIN_SYSTEMD or newer."
}

# From `getconf GNU_LIBC_VERSION`, which only glibc answers ("glibc 2.36").
check_libc() {
  local answer="$1"
  [[ "$answer" == glibc\ * ]] ||
    die "this release is built for glibc; this system's C library is not glibc (musl is not supported)."
}

# Maps `uname -m` to a release architecture.
release_arch_of() {
  case "$1" in
    x86_64 | amd64) printf 'x64' ;;
    aarch64 | arm64) printf 'arm64' ;;
    *) die "the $1 architecture is not supported: install on x86-64 or arm64." ;;
  esac
}

check_arch() {
  local machine="$1" bundle_arch="$2" host_arch
  host_arch=$(release_arch_of "$machine")
  [[ "$host_arch" == "$bundle_arch" ]] ||
    die "this tarball is for linux-$bundle_arch, but this host is linux-$host_arch: download not-unreachable-<version>-linux-$host_arch.tar.gz."
}

# Given `node --version` ("v24.11.1") or nothing when there is no /usr/bin/node: succeeds when it is
# usable, fails (1) when Node must be installed, and refuses another major.
check_node() {
  local version="${1#v}" major minor
  [[ -n "$version" ]] || return 1
  IFS=. read -r major minor _ <<<"$version"
  [[ "$major" == "$NODE_MAJOR" ]] ||
    die "/usr/bin/node is Node $version; NotUnreachable needs Node $NODE_MAJOR and won't replace another major. Remove it, or install on a host without it."
  ((10#$minor >= NODE_MIN_MINOR)) ||
    die "/usr/bin/node is Node $version; NotUnreachable needs Node $NODE_MAJOR.$NODE_MIN_MINOR or newer. Upgrade it, then run this again."
}

# ---------------------------------------------------------------------------------------------------
# The release bundle

# install.sh sits at the tarball's root, next to release/ and deploy/; in the repository it is deploy/.
# A release's kept installer sits in <release>/installer/, next to deploy/, inside the release itself.
locate_bundle() {
  local here
  here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
  if [[ -d "$here/release" ]]; then
    printf '%s' "$here"
  elif [[ -d "$here/../release" ]]; then
    (cd "$here/.." && pwd -P)
  elif [[ "$(basename "$here")" == "$INSTALLER_DIR_NAME" && -d "$here/deploy" && -f "$here/../dist/main.js" ]]; then
    printf '%s' "$here"
  else
    die "no release/ next to $here: run install.sh from the unpacked release tarball."
  fi
}

# The release folder to install: the tarball's release/, or the installed release a kept installer sits in.
locate_release() {
  if [[ -d "$BUNDLE/release" ]]; then
    printf '%s' "$BUNDLE/release"
  else
    (cd "$BUNDLE/.." && pwd -P)
  fi
}

read_bundle_file() {
  local file="$BUNDLE/$1" value
  [[ -r "$file" ]] || die "the tarball has no $1: download it again."
  value=$(tr -d '[:space:]' <"$file")
  [[ "$value" =~ $2 ]] || die "the tarball's $1 is not valid: \"$value\"."
  printf '%s' "$value"
}

# ---------------------------------------------------------------------------------------------------
# Packages

install_packages() {
  local manager="$1" node_version="$2"
  case "$manager" in
    apt)
      step "Installing cifs-utils, polkit and ca-certificates"
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -q
      apt-get install -y -q --no-install-recommends cifs-utils polkitd ca-certificates
      ;;
    dnf)
      step "Installing cifs-utils, polkit and ca-certificates"
      dnf install -y -q cifs-utils polkit ca-certificates
      ;;
  esac
  if check_node "$node_version"; then
    step "Using /usr/bin/node $node_version"
    return
  fi
  install_node "$manager"
  check_node "$(/usr/bin/node --version)" || die "Node $NODE_MAJOR did not install to /usr/bin/node."
}

# Node 24 from NodeSource. Its signing key ships in the tarball (deploy/keys/), so nothing is trusted
# that the release's SHA256SUMS doesn't cover.
install_node() {
  local manager="$1"
  step "Installing Node $NODE_MAJOR from NodeSource"
  case "$manager" in
    apt)
      install -d -m 0755 /etc/apt/keyrings /etc/apt/preferences.d
      install -m 0644 "$BUNDLE/deploy/keys/nodesource-deb.asc" /etc/apt/keyrings/nodesource.asc
      printf 'Types: deb\nURIs: https://deb.nodesource.com/node_%s.x\nSuites: nodistro\nComponents: main\nSigned-By: /etc/apt/keyrings/nodesource.asc\n' \
        "$NODE_MAJOR" >/etc/apt/sources.list.d/nodesource.sources
      # The distribution's own nodejs is another major: NodeSource's wins.
      printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' >/etc/apt/preferences.d/nodesource
      apt-get update -q
      apt-get install -y -q nodejs
      ;;
    dnf)
      install -m 0644 "$BUNDLE/deploy/keys/nodesource-rpm.asc" /etc/pki/rpm-gpg/RPM-GPG-KEY-nodesource
      rpm --import /etc/pki/rpm-gpg/RPM-GPG-KEY-nodesource
      # priority beats the distribution's nodejs; module_hotfixes lets it past RHEL's nodejs module.
      # shellcheck disable=SC2016 # $basearch is dnf's variable, not the shell's.
      printf '[nodesource-nodejs]\nname=Node.js %s from NodeSource\nbaseurl=https://rpm.nodesource.com/pub_%s.x/nodistro/nodejs/$basearch\nenabled=1\npriority=9\nmodule_hotfixes=1\ngpgcheck=1\nrepo_gpgcheck=0\ngpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-nodesource\n' \
        "$NODE_MAJOR" "$NODE_MAJOR" >/etc/yum.repos.d/nodesource-nodejs.repo
      dnf install -y -q nodejs
      ;;
  esac
}

# ---------------------------------------------------------------------------------------------------
# Files

# Makes a directory with an owner and mode; DESTDIR runs keep the mode only (they are not root).
make_dir() {
  local path owner="$2" mode="$3"
  path=$(target "$1")
  install -d -m "$mode" "$path"
  chmod "$mode" "$path"
  in_destdir || chown "$owner" "$path"
}

put_file() {
  local source="$1" path owner="$3" mode="$4"
  path=$(target "$2")
  install -D -m "$mode" "$source" "$path"
  in_destdir || chown "$owner" "$path"
}

install_system_files() {
  step "Installing the units, the polkit rules, the mount, folder and update helpers and the CLI"
  install_sysusers_file
  put_file "$BUNDLE/deploy/tmpfiles/not-unreachable.conf" "$TMPFILES_FILE" root:root 0644
  local unit
  for unit in "${UNITS[@]}"; do
    put_file "$BUNDLE/deploy/systemd/$unit" "$UNIT_DIR/$unit" root:root 0644
  done
  put_file "$BUNDLE/deploy/polkit/50-not-unreachable.rules" "$POLKIT_RULE" root:root 0644
  make_dir "$HELPER_DIR" root:root 0755
  local file
  for file in "${HELPER_FILES[@]}"; do
    put_file "$BUNDLE/deploy/$file" "$HELPER_DIR/$file" root:root 0644
  done
  put_file "$BUNDLE/deploy/polkit/$FOLDER_RULE_NAME" "$FOLDER_RULE_SOURCE" root:root 0644
  put_file "$BUNDLE/deploy/polkit/$UPDATE_RULE_NAME" "$UPDATE_RULE_SOURCE" root:root 0644
  put_file "$BUNDLE/deploy/bin/not-unreachable" "$CLI_PATH" root:root 0755
  remove_unshipped_files
}

# install.sh owns its system files by name (deployment.md, "Upgrades"): the units, the polkit rules and
# everything in the helpers' folder. It removes the owned ones this release doesn't ship, so they always
# match one release exactly, whether this run upgrades, rolls back or installs an older tarball.
remove_unshipped_files() {
  local path
  for path in "$(target "$UNIT_DIR")"/not-unreachable*.service "$(target "$UNIT_DIR")"/not-unreachable*.timer; do
    contains "$(basename "$path")" "${UNITS[@]}" || remove_unshipped "$path"
  done
  for path in "$(target /etc/polkit-1/rules.d)"/5?-not-unreachable*.rules; do
    contains "$(basename "$path")" "${POLKIT_RULES[@]}" || remove_unshipped "$path"
  done
  while IFS= read -r -d '' path; do
    contains "$(basename "$path")" "${HELPER_FILES[@]}" "$FOLDER_RULE_NAME" "$UPDATE_RULE_NAME" || remove_unshipped "$path"
  done < <(find "$(target "$HELPER_DIR")" -mindepth 1 -maxdepth 1 -print0)
}

remove_unshipped() {
  step "Removing ${1#"$DESTDIR"}, which this release doesn't ship"
  rm -rf -- "$1"
}

# The tarball's sysusers file with the chosen IDs in place of its defaults.
install_sysusers_file() {
  local rendered
  rendered=$(mktemp)
  sed -E -e "s/^(g $SERVICE_USER )[0-9]+\$/\\1$SERVICE_GID/" -e "s/^(u $SERVICE_USER )[0-9]+:/\\1$SERVICE_UID:/" \
    "$BUNDLE/deploy/sysusers/not-unreachable.conf" >"$rendered"
  if ! grep -qx "g $SERVICE_USER $SERVICE_GID" "$rendered" || ! grep -q "^u $SERVICE_USER $SERVICE_UID:$SERVICE_USER " "$rendered"; then
    rm -f -- "$rendered"
    die "the tarball's deploy/sysusers/not-unreachable.conf has no g and u line for $SERVICE_USER: download it again."
  fi
  put_file "$rendered" "$SYSUSERS_FILE" root:root 0644
  rm -f -- "$rendered"
}

create_service_user() {
  # --apply-update checked that it exists; its unit can't write /etc anyway.
  if in_destdir || "$APPLY_UPDATE"; then
    return
  fi
  step "Creating the service user $SERVICE_USER (no shell, no login)"
  systemd-sysusers "$SYSUSERS_FILE"
}

# ---------------------------------------------------------------------------------------------------
# The service user's ID (docs/install.md, "The service user's ID"). It is fixed, so a folder passed
# into an LXC container can be mapped before installing.

valid_service_id() {
  [[ "$1" =~ ^[1-9][0-9]{0,4}$ ]] && ((10#$1 <= MAX_SERVICE_ID))
}

# "<uid> <gid>" of the service user as the system has it (the GID of its primary group), or nothing.
existing_service_ids() {
  local entry uid gid
  entry=$(getent passwd "$SERVICE_USER") || return 0
  IFS=: read -r _ _ uid gid _ <<<"$entry"
  printf '%s %s' "$uid" "$gid"
}

# "<uid> <gid>" from an installed sysusers file, or nothing when it has no fixed IDs (or is missing).
# DESTDIR runs have no users, so this tells them an upgrade.
sysusers_file_ids() {
  local file="$1" uid gid
  [[ -r "$file" ]] || return 0
  uid=$(sed -nE "s/^u $SERVICE_USER ([0-9]+):.*/\\1/p" "$file")
  gid=$(sed -nE "s/^g $SERVICE_USER ([0-9]+)\$/\\1/p" "$file")
  [[ -n "$uid" && -n "$gid" ]] && printf '%s %s' "$uid" "$gid"
  return 0
}

# Prints why the service user can't have this UID and GID, if another user or group has them.
service_id_conflict() {
  local uid="$1" gid="$2" owner group
  owner=$(getent passwd "$uid" | cut -d: -f1) || true
  group=$(getent group "$gid" | cut -d: -f1) || true
  if [[ -n "$owner" && "$owner" != "$SERVICE_USER" ]]; then
    printf 'UID %s is already the user %s'"'"'s' "$uid" "$owner"
  elif [[ -n "$group" && "$group" != "$SERVICE_USER" ]]; then
    printf 'GID %s is already the group %s'"'"'s' "$gid" "$group"
  fi
}

# Sets SERVICE_UID and SERVICE_GID, before anything is changed: an existing service user's own IDs
# (never changed), else --uid or NU_UID, else the answer to a question, 2000 by default.
choose_service_id() {
  local existing
  if in_destdir; then
    existing=$(sysusers_file_ids "$(target "$SYSUSERS_FILE")")
  else
    existing=$(existing_service_ids)
  fi
  if [[ -n "$existing" ]]; then
    read -r SERVICE_UID SERVICE_GID <<<"$existing"
    step "Keeping the service user $SERVICE_USER with UID $SERVICE_UID and GID $SERVICE_GID"
    if [[ -n "$REQUESTED_SERVICE_ID" && "$REQUESTED_SERVICE_ID $REQUESTED_SERVICE_ID" != "$existing" ]]; then
      warn "$SERVICE_USER exists already, so it keeps UID $SERVICE_UID and GID $SERVICE_GID, not $REQUESTED_SERVICE_ID. To move it, see docs/install.md, \"Changing the service user's ID\"."
    fi
    return
  fi

  local id="$REQUESTED_SERVICE_ID" interactive=false conflict
  if [[ -z "$id" ]] && ! "$ASSUME_YES" && [[ -t 0 ]]; then
    interactive=true
    printf 'The service user %s gets a fixed UID and GID, the same number, so a folder passed into an\n' "$SERVICE_USER"
    printf 'LXC container can be mapped to it (docs/install.md, "The service user'"'"'s ID").\n'
  fi
  while true; do
    if "$interactive"; then
      id=$(trim "$(ask "UID and GID of the service user [$DEFAULT_SERVICE_ID]: ")")
      id="${id:-$DEFAULT_SERVICE_ID}"
      if ! valid_service_id "$id"; then
        warn "\"$id\" is not a number from 1 to $MAX_SERVICE_ID."
        continue
      fi
    fi
    SERVICE_UID="${id:-$DEFAULT_SERVICE_ID}"
    SERVICE_GID="$SERVICE_UID"
    in_destdir && break
    use_existing_service_group
    conflict=$(service_id_conflict "$SERVICE_UID" "$SERVICE_GID")
    [[ -n "$conflict" ]] || break
    "$interactive" || die "$conflict: choose another ID with --uid or NU_UID. Nothing was changed."
    warn "$conflict: choose another."
  done
  step "The service user $SERVICE_USER gets UID $SERVICE_UID and GID $SERVICE_GID"
}

# A group named like the service user, left without it, is the one it joins: sysusers keeps it.
use_existing_service_group() {
  local gid
  gid=$(getent group "$SERVICE_USER" | cut -d: -f3) || true
  [[ -n "$gid" && "$gid" != "$SERVICE_GID" ]] || return 0
  warn "the group $SERVICE_USER exists already with GID $gid, so the service user joins it with GID $gid, not $SERVICE_GID."
  SERVICE_GID=$gid
}

make_directories() {
  # The update helper's apply unit can't write /etc/not-unreachable, which an upgrade never changes
  # anyway (--apply-update checked the config and the key are there); the audit still checks them.
  if ! "$APPLY_UPDATE"; then
    make_dir "$CONFIG_DIR" root:root 0755
    make_dir "$CREDENTIALS_DIR" root:root 0700
  fi
  make_dir "$DATA_DIR" "$SERVICE_USER:$SERVICE_USER" 0700
  local sub
  for sub in db uploads backups updates; do
    make_dir "$DATA_DIR/$sub" "$SERVICE_USER:$SERVICE_USER" 0700
  done
  # The update units' StateDirectory=, made now so the mode audit sees it before the first update.
  make_dir "$UPDATE_STATE_DIR" root:root 0755
  make_dir "$UPDATE_WORK_DIR" root:root 0700
  make_dir "$MOUNTS_PARENT" root:root 0755
  make_dir "$MOUNTS_DIR" root:root 0755
  # The folder helper's unit can't start unless the folder its ReadWritePaths= names exists.
  make_dir "$DROP_IN_DIR" root:root 0755
  if in_destdir; then
    make_dir "$HELPER_RUN_DIR" root:root 0700
  else
    systemd-tmpfiles --create "$TMPFILES_FILE"
  fi
}

# Unpacks the release to /opt/not-unreachable/<version> (root-owned, read-only for everyone else), with
# this installer in its installer/ folder, and switches `current` to it atomically. Prints the release
# `current` pointed at before, if another. A kept installer finds its release in place already.
install_release() {
  local opt version_dir current previous=""
  opt=$(target "$OPT_DIR")
  version_dir="$opt/$VERSION"
  current="$opt/current"
  make_dir "$OPT_DIR" root:root 0755
  [[ -L "$current" ]] && previous=$(readlink "$current")

  if [[ ! -d "$version_dir" ]]; then
    local staging="$opt/.$VERSION.partial"
    rm -rf -- "$staging"
    cp -R -- "$RELEASE_SOURCE" "$staging"
    # What a rollback to this release runs: this script and the system files it installs.
    mkdir -- "$staging/$INSTALLER_DIR_NAME"
    cp -R -- "$BUNDLE/install.sh" "$BUNDLE/deploy" "$BUNDLE/VERSION" "$BUNDLE/ARCH" "$staging/$INSTALLER_DIR_NAME/"
    in_destdir || chown -R -h root:root "$staging"
    chmod -R u+rwX,go+rX,go-w "$staging"
    chmod 0755 "$staging"
    mv -T -- "$staging" "$version_dir"
  fi
  ln -sfn -- "$VERSION" "$current.new"
  mv -T -- "$current.new" "$current"

  [[ -n "$previous" && "$previous" != "$VERSION" ]] && printf '%s' "$previous"
  return 0
}

# After an upgrade, keeps the release in use and the one it replaced (for rollback); removes older ones.
prune_releases() {
  local keep_previous="$1" opt entry name
  opt=$(target "$OPT_DIR")
  for entry in "$opt"/*/; do
    name=$(basename "$entry")
    [[ "$name" == "$VERSION" || "$name" == "$keep_previous" || "$name" == current ]] && continue
    step "Removing the old release $name"
    rm -rf -- "${entry%/}"
  done
}

# 32 bytes from the kernel's random source, made once: an existing key is never touched.
create_master_key() {
  local key temporary
  key=$(target "$MASTER_KEY_FILE")
  if [[ -e "$key" ]]; then
    step "Keeping the master key $MASTER_KEY_FILE"
    return
  fi
  step "Creating the master key $MASTER_KEY_FILE"
  temporary=$(mktemp "$(dirname "$key")/.master.key.XXXXXX")
  head -c "$MASTER_KEY_BYTES" /dev/urandom >"$temporary"
  chmod 0600 "$temporary"
  in_destdir || chown root:root "$temporary"
  sync -- "$temporary"
  # ln refuses an existing name, so two installs at once can't replace a key.
  if ! ln -- "$temporary" "$key" 2>/dev/null; then
    rm -f -- "$temporary"
    die "$MASTER_KEY_FILE appeared while installing; nothing was overwritten. Run this again."
  fi
  rm -f -- "$temporary"
}

# PUBLIC_ORIGIN: an https origin, no path (deployment.md, "Bootstrap config").
valid_public_origin() {
  [[ "$1" =~ ^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$ ]]
}

ask() {
  local prompt="$1" answer
  [[ -t 0 ]] || die "$prompt: no terminal to ask on; pass it as an option (see --help)."
  read -r -p "$prompt" answer
  printf '%s' "$answer"
}

write_config() {
  local config
  config=$(target "$CONFIG_FILE")
  if [[ -e "$config" ]]; then
    step "Keeping the config $CONFIG_FILE"
    CONFIG_IS_NEW=false
    return
  fi
  CONFIG_IS_NEW=true
  local origin="$PUBLIC_ORIGIN"
  while ! valid_public_origin "$origin"; do
    [[ -z "$origin" ]] || warn "\"$origin\" is not an https origin such as https://files.example.com (no path)."
    "$ASSUME_YES" && die "--public-origin https://<host> is required with --yes."
    origin=$(ask "Public address of the site, such as https://files.example.com: ")
  done
  step "Writing the config $CONFIG_FILE"
  local temporary
  temporary=$(mktemp "$(dirname "$config")/.config.env.XXXXXX")
  cat >"$temporary" <<EOF
# NotUnreachable bootstrap config (docs/design/deployment.md, "Config, secrets and data").
# Everything else is a setting in the admin interface. Restart the service after a change:
#   systemctl restart $SERVICE_UNIT
PUBLIC_ORIGIN=$origin
LISTEN_HOST=127.0.0.1
LISTEN_PORT=8480
# The reverse proxy's addresses; its X-Forwarded-For and X-Forwarded-Proto are believed. Never *.
TRUSTED_PROXIES=127.0.0.1,::1
LOG_LEVEL=info
HSTS_INCLUDE_SUBDOMAINS=false
# Whether admins may allow local folders from the admin interface, after signing in again; off, a
# folder is allowed with "not-unreachable allow-folder <path>" only. Switch it with
#   not-unreachable allow-folders-from-ui on|off
# which also installs or removes the polkit rule (docs/install.md, "Allowing folders from the admin
# interface"). Only folders inside these comma-separated prefixes can be allowed that way.
ALLOW_FOLDERS_FROM_UI=false
ALLOWED_FOLDER_PREFIXES=/srv,/mnt
# Whether the server asks GitHub for the latest release, to show it in Settings > Updates; false for a
# host that must not reach GitHub.
UPDATE_CHECK=true
# Whether admins may install a newer release from Settings > Updates, after signing in again. Switch
# it with
#   not-unreachable update-from-ui on|off
# which also installs or removes the polkit rule (docs/install.md, "Updating from Settings").
UPDATE_FROM_UI=false
EOF
  chmod 0640 "$temporary"
  in_destdir || chown "root:$SERVICE_USER" "$temporary"
  mv -T -- "$temporary" "$config"
}

trim() {
  local text="$1"
  text="${text#"${text%%[![:space:]]*}"}"
  printf '%s' "${text%"${text##*[![:space:]]}"}"
}

# A key's value in an EnvironmentFile= such as config.env, read as the folder helper reads it: blank
# lines and lines starting with # or ; skipped, trimmed, one pair of matching quotes stripped, the
# last line winning. Empty when the key or the file is missing.
config_value() {
  local file="$1" wanted="$2" line key value found=""
  [[ -r "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line=$(trim "$line")
    [[ -z "$line" || "$line" == [\#\;]* || "$line" != ?*=* ]] && continue
    key=$(trim "${line%%=*}")
    [[ "$key" == "$wanted" ]] || continue
    value=$(trim "${line#*=}")
    if ((${#value} >= 2)) && [[ "$value" == \"*\" || "$value" == \'*\' ]]; then
      value=${value:1:-1}
    fi
    found="$value"
  done <"$file"
  printf '%s' "$found"
}

# The allow-folder and update polkit rules are active only while config.env has their switch set to
# true, so an upgrade never turns one on, and a rule left behind by hand goes when its switch is off.
sync_switch_rule() {
  local key="$1" rule_name="$2" off_note="$3" rule="/etc/polkit-1/rules.d/$2"
  if [[ "$(config_value "$(target "$CONFIG_FILE")" "$key")" == true ]]; then
    step "$key=true: installing the polkit rule $rule"
    put_file "$BUNDLE/deploy/polkit/$rule_name" "$rule" root:root 0644
  else
    step "$key is off: no polkit rule $rule ($off_note)"
    rm -f -- "$(target "$rule")"
  fi
}

sync_switch_rules() {
  sync_switch_rule ALLOW_FOLDERS_FROM_UI "$FOLDER_RULE_NAME" "folders are allowed with not-unreachable allow-folder"
  sync_switch_rule UPDATE_FROM_UI "$UPDATE_RULE_NAME" "updates are installed over SSH"
}

# The local folders the service may write to: the --allow-folder options, or asked on a first install.
folders_to_allow() {
  if ((${#ALLOW_FOLDERS[@]} > 0)) || ! "$CONFIG_IS_NEW" || "$ASSUME_YES" || [[ ! -t 0 ]]; then
    return
  fi
  printf 'Local folders the service may share (one absolute path per line, an empty line to finish;\n'
  printf 'add more later with "not-unreachable allow-folder <path>"). Folders here must not be\n'
  printf 'writable by other users of this computer.\n'
  local folder
  while folder=$(ask "Folder: ") && [[ -n "$folder" ]]; do
    ALLOW_FOLDERS+=("$folder")
  done
}

# ---------------------------------------------------------------------------------------------------
# Checks after install

# One row per path: path, owner:group, mode, kind (d, f or l). A missing optional path (?) is fine.
layout_rows() {
  cat <<EOF
$OPT_DIR root:root 755 d
$OPT_DIR/$VERSION root:root 755 d
$OPT_DIR/$VERSION/$INSTALLER_DIR_NAME root:root 755 d
$OPT_DIR/$VERSION/$TRUSTED_KEYS_DIR_NAME root:root 755 d
$OPT_DIR/current root:root - l
$CLI_PATH root:root 755 f
$HELPER_DIR root:root 755 d
$HELPER_PATH root:root 644 f
$HELPER_DIR/request-file.mjs root:root 644 f
$HELPER_DIR/folder-access.mjs root:root 644 f
$HELPER_DIR/folder-helper.mjs root:root 644 f
$FOLDER_RULE_SOURCE root:root 644 f
$HELPER_DIR/update-helper.mjs root:root 644 f
$UPDATE_RULE_SOURCE root:root 644 f
$CONFIG_DIR root:root 755 d
$CONFIG_FILE root:$SERVICE_USER 640 f
$CREDENTIALS_DIR root:root 700 d
$MASTER_KEY_FILE root:root 600 f
$DATA_DIR $SERVICE_USER:$SERVICE_USER 700 d
$DATA_DIR/db $SERVICE_USER:$SERVICE_USER 700 d
$DATA_DIR/db/not-unreachable.sqlite $SERVICE_USER:$SERVICE_USER 600 f?
$DATA_DIR/uploads $SERVICE_USER:$SERVICE_USER 700 d
$DATA_DIR/backups $SERVICE_USER:$SERVICE_USER 700 d
$DATA_DIR/updates $SERVICE_USER:$SERVICE_USER 700 d
$UPDATE_STATE_DIR root:root 755 d
$UPDATE_STATUS_FILE root:root 644 f?
$UPDATE_WORK_DIR root:root 700 d
$MOUNTS_PARENT root:root 755 d
$MOUNTS_DIR root:root 755 d
$SERVICE_RUN_DIR $SERVICE_USER:$SERVICE_USER 700 d?
$HELPER_RUN_DIR root:root 700 d
$UNIT_DIR/$SERVICE_UNIT root:root 644 f
$UNIT_DIR/$BACKUP_UNIT root:root 644 f
$UNIT_DIR/$BACKUP_TIMER root:root 644 f
$UNIT_DIR/$MOUNT_UNIT_TEMPLATE root:root 644 f
$UNIT_DIR/$ALLOW_FOLDER_UNIT root:root 644 f
$UNIT_DIR/$UPDATE_UNIT root:root 644 f
$UNIT_DIR/$UPDATE_APPLY_UNIT root:root 644 f
$DROP_IN_DIR root:root 755 d
$POLKIT_RULE root:root 644 f
$FOLDER_RULE root:root 644 f?
$UPDATE_RULE root:root 644 f?
$SYSUSERS_FILE root:root 644 f
$TMPFILES_FILE root:root 644 f
EOF
}

# Checks every path's kind, mode and (outside DESTDIR) owner; prints each problem and fails on any.
audit_layout() {
  step "Checking the owner and mode of every installed path"
  local problems=0 path owner mode kind actual_owner actual_mode file
  while read -r path owner mode kind; do
    file=$(target "$path")
    local optional=false
    [[ "$kind" == *\? ]] && optional=true kind=${kind%\?}
    if [[ ! -e "$file" && ! -L "$file" ]]; then
      "$optional" || { warn "missing: $path"; problems=$((problems + 1)); }
      continue
    fi
    case "$kind" in
      d) [[ -d "$file" && ! -L "$file" ]] || { warn "$path is not a folder"; problems=$((problems + 1)); continue; } ;;
      f) [[ -f "$file" && ! -L "$file" ]] || { warn "$path is not a regular file"; problems=$((problems + 1)); continue; } ;;
      l) [[ -L "$file" ]] || { warn "$path is not a symlink"; problems=$((problems + 1)); } ; continue ;;
    esac
    actual_mode=$(stat -c '%a' -- "$file")
    [[ "$actual_mode" == "$mode" ]] || { warn "$path has mode $actual_mode, not $mode"; problems=$((problems + 1)); }
    if ! in_destdir; then
      actual_owner=$(stat -c '%U:%G' -- "$file")
      [[ "$actual_owner" == "$owner" ]] || { warn "$path belongs to $actual_owner, not $owner"; problems=$((problems + 1)); }
    fi
  done < <(layout_rows)

  # The helpers' modules have no row of their own in deployment.md's table, but run as root all the same.
  for file in "${HELPER_FILES[@]}"; do
    file=$(target "$HELPER_DIR/$file")
    if [[ ! -f "$file" || -L "$file" ]]; then
      warn "missing: ${file#"$DESTDIR"}"
      problems=$((problems + 1))
      continue
    fi
    actual_mode=$(stat -c '%a' -- "$file")
    [[ "$actual_mode" == 644 ]] || { warn "${file#"$DESTDIR"} has mode $actual_mode, not 644"; problems=$((problems + 1)); }
    if ! in_destdir; then
      actual_owner=$(stat -c '%U:%G' -- "$file")
      [[ "$actual_owner" == root:root ]] || { warn "${file#"$DESTDIR"} belongs to $actual_owner, not root:root"; problems=$((problems + 1)); }
    fi
  done

  local key size
  key=$(target "$MASTER_KEY_FILE")
  size=$(stat -c '%s' -- "$key" 2>/dev/null || printf 0)
  [[ "$size" == "$MASTER_KEY_BYTES" ]] || { warn "$MASTER_KEY_FILE holds $size bytes, not $MASTER_KEY_BYTES"; problems=$((problems + 1)); }

  # The release is read-only for everyone but root: nothing in it is writable by group or others.
  local writable
  writable=$(find "$(target "$OPT_DIR/$VERSION")" ! -type l -perm /022 -print -quit)
  [[ -z "$writable" ]] || { warn "$writable is writable by others"; problems=$((problems + 1)); }
  if ! in_destdir; then
    writable=$(find "$(target "$OPT_DIR/$VERSION")" ! -user root -print -quit)
    [[ -z "$writable" ]] || { warn "$writable does not belong to root"; problems=$((problems + 1)); }
    local shell
    shell=$(getent passwd "$SERVICE_USER" | cut -d: -f7)
    [[ "$shell" == */nologin || "$shell" == /bin/false ]] || { warn "$SERVICE_USER has the shell $shell"; problems=$((problems + 1)); }
    local password
    password=$(getent shadow "$SERVICE_USER" | cut -d: -f2)
    [[ "$password" == '!'* || "$password" == '*' ]] || { warn "$SERVICE_USER's password is not locked"; problems=$((problems + 1)); }
    local ids
    ids=$(existing_service_ids)
    [[ "$ids" == "$SERVICE_UID $SERVICE_GID" ]] || { warn "$SERVICE_USER has the UID and GID \"$ids\", not $SERVICE_UID $SERVICE_GID"; problems=$((problems + 1)); }
  fi

  ((problems == 0)) || die "$problems path(s) don't have the owner or mode docs/design/deployment.md lists."
}

check_unit_exposure() {
  local unit="$1" max_exposure="$2" threshold="$3" report
  if ! report=$(systemd-analyze security --no-pager --threshold="$threshold" "$unit" 2>&1); then
    printf '%s\n' "$report" >&2
    die "$unit's exposure is above $max_exposure; was the unit or a drop-in changed?"
  fi
  grep -F 'Overall exposure level' <<<"$report" || true
}

check_exposure() {
  step "Checking the service's sandbox (systemd-analyze security, exposure $MAX_EXPOSURE or less)"
  check_unit_exposure "$SERVICE_UNIT" "$MAX_EXPOSURE" "$SECURITY_THRESHOLD"
  step "Checking the folder helper's sandbox (exposure $HELPER_MAX_EXPOSURE or less)"
  check_unit_exposure "$ALLOW_FOLDER_UNIT" "$HELPER_MAX_EXPOSURE" "$HELPER_SECURITY_THRESHOLD"
  step "Checking the update helper's verify unit's sandbox (exposure $HELPER_MAX_EXPOSURE or less)"
  check_unit_exposure "$UPDATE_UNIT" "$HELPER_MAX_EXPOSURE" "$HELPER_SECURITY_THRESHOLD"
  step "Checking the update helper's apply unit's sandbox (exposure $APPLY_MAX_EXPOSURE or less)"
  check_unit_exposure "$UPDATE_APPLY_UNIT" "$APPLY_MAX_EXPOSURE" "$APPLY_SECURITY_THRESHOLD"
}

# ---------------------------------------------------------------------------------------------------
# Updates from Settings (deployment.md, "Updating from Settings")

# An update from Settings that is running owns the release and the system files until it ends.
refuse_while_updating() {
  local changed="${1:-Nothing was changed.}" unit state
  for unit in "$UPDATE_UNIT" "$UPDATE_APPLY_UNIT"; do
    state=$(systemctl is-active "$unit" 2>/dev/null) || true
    case "$state" in
      active | activating | deactivating | reloading)
        die "an update from Settings is running ($unit is $state): wait for it to end (journalctl -fu $unit), then run this again. $changed"
        ;;
    esac
  done
}

# An install over SSH holds updates from Settings until it exits, however it exits: a runtime drop-in
# (gone at a reboot) refuses a start of either update unit, so the service can't start one meanwhile.
# Not `systemctl mask --runtime`, which /etc/systemd/system's unit file outranks, nor a mask in /etc,
# where install_system_files puts the unit file. Given the runtime unit folder ($RUNTIME_UNIT_DIR).
UPDATES_HELD_IN=""
hold_updates() {
  local unit
  UPDATES_HELD_IN="$1"
  trap release_updates EXIT
  for unit in "$UPDATE_UNIT" "$UPDATE_APPLY_UNIT"; do
    mkdir -p -- "$UPDATES_HELD_IN/$unit.d"
    printf '# install.sh is running; it removes this when it exits.\n[Unit]\nRefuseManualStart=yes\n' \
      >"$UPDATES_HELD_IN/$unit.d/$HOLD_DROP_IN"
  done
  systemctl daemon-reload
  # After the hold, so one that started just before it is seen.
  refuse_while_updating
}

# hold_updates's EXIT trap: the exit status stays the one the install exits with.
release_updates() {
  [[ -n "$UPDATES_HELD_IN" ]] || return 0
  local unit
  for unit in "$UPDATE_UNIT" "$UPDATE_APPLY_UNIT"; do
    rm -f -- "$UPDATES_HELD_IN/$unit.d/$HOLD_DROP_IN"
    rmdir -- "$UPDATES_HELD_IN/$unit.d" 2>/dev/null || true
  done
  UPDATES_HELD_IN=""
  systemctl daemon-reload || warn "systemctl daemon-reload failed: updates from Settings stay refused until it runs."
}

# Marks the status file's update as interrupted when it is still in progress, keeping it valid against
# the server's schema (updateStatusFileSchema): written beside it, synced, then renamed over it.
# shellcheck disable=SC2016 # JavaScript, not shell.
readonly MARK_INTERRUPTED_JS='
const fs = require("node:fs");
const file = process.argv[1];
const status = JSON.parse(fs.readFileSync(file, "utf8"));
if (status === null || typeof status !== "object" || status.phase === "finished") process.exit(0);
const now = new Date().toISOString();
Object.assign(status, { phase: "finished", result: "interrupted", reason: "interrupted", updatedAt: now, finishedAt: now });
const temporary = `${file}.${process.pid}.tmp`;
const descriptor = fs.openSync(temporary, "wx", 0o644);
fs.writeSync(descriptor, `${JSON.stringify(status)}\n`);
fs.fsyncSync(descriptor);
fs.closeSync(descriptor);
fs.renameSync(temporary, file);
process.stdout.write("interrupted");
'

# An install over SSH ends an update from Settings that stopped half-way (a power cut, a killed unit):
# it puts every system file and the release in place itself, so the lock and the work folder go, and a
# status still in progress becomes interrupted. make_directories makes the work folder again, empty.
end_interrupted_update() {
  local work status_file outcome
  work=$(target "$UPDATE_WORK_DIR")
  status_file=$(target "$UPDATE_STATUS_FILE")
  if [[ -d "$work" && -n "$(ls -A -- "$work")" ]]; then
    step "Ending the update from Settings that stopped half-way: removing its lock and work folder"
  fi
  rm -rf -- "$work"
  [[ -f "$status_file" ]] || return 0
  local node="$NODE"
  in_destdir && node="${DESTDIR_NODE:-$NODE}"
  if [[ ! -x "$node" ]]; then
    warn "no $node to read $UPDATE_STATUS_FILE with; left as it is."
    return 0
  fi
  if ! outcome=$("$node" -e "$MARK_INTERRUPTED_JS" "$status_file" 2>/dev/null); then
    warn "$UPDATE_STATUS_FILE can't be read; left as it is (the server shows it as unknown)."
    return 0
  fi
  [[ "$outcome" != interrupted ]] || step "Marked the update from Settings in $UPDATE_STATUS_FILE as interrupted"
}

# ---------------------------------------------------------------------------------------------------
# Install

reload_systemd() {
  step "Reloading systemd"
  systemctl daemon-reload
  systemctl restart polkit.service || warn "could not restart polkit; it picks the rule up on its own."
}

# The steps of a rollback to the release before (docs/install.md, "Upgrade and rollback").
rollback_steps() {
  local previous="$1"
  printf 'To roll back to %s (docs/install.md, "Upgrade and rollback"):\n' "$previous"
  printf '  systemctl stop %s\n' "$SERVICE_UNIT"
  printf '  # If this start migrated the database, first put back the newest %s/backups/pre-migration-*.sqlite.\n' "$DATA_DIR"
  if [[ -f "$(target "$OPT_DIR/$previous/$INSTALLER_DIR_NAME/install.sh")" ]]; then
    printf '  bash %s/%s/%s/install.sh --yes\n' "$OPT_DIR" "$previous" "$INSTALLER_DIR_NAME"
  else
    # A release from before releases kept their installer: switch back by hand.
    printf '  ln -sfn %s %s/current\n' "$previous" "$OPT_DIR"
    printf '  systemctl start %s\n' "$SERVICE_UNIT"
  fi
}

start_service() {
  local upgraded_from="$1"
  reload_systemd

  local folder
  for folder in "${ALLOW_FOLDERS[@]}"; do
    step "Allowing the folder $folder"
    "$CLI_PATH" allow-folder "$folder"
  done

  step "Starting $SERVICE_UNIT (it runs pending migrations first)"
  systemctl enable "$SERVICE_UNIT" "$BACKUP_TIMER"
  if [[ -n "$upgraded_from" ]] || ! systemctl is-active --quiet "$SERVICE_UNIT"; then
    systemctl restart "$SERVICE_UNIT" ||
      die "$SERVICE_UNIT did not start; see journalctl -u $SERVICE_UNIT.$([[ -z "$upgraded_from" ]] || printf '\n%s' "$(rollback_steps "$upgraded_from")")"
  fi
  systemctl start "$BACKUP_TIMER"
}

print_finish() {
  local upgraded_from="$1"
  printf '\n%sNotUnreachable %s is installed and running.%s\n' "$BOLD" "$VERSION" "$RESET"
  if [[ -n "$upgraded_from" ]]; then
    printf 'Upgraded from %s, which is kept in %s/%s for a rollback (docs/install.md, "Upgrade and rollback").\n' \
      "$upgraded_from" "$OPT_DIR" "$upgraded_from"
  fi
  if ! in_destdir; then
    printf '\n'
    "$CLI_PATH" setup-link || printf 'An admin exists already, so there is no setup link.\n'
  fi
  cat <<EOF

The service user $SERVICE_USER has UID $SERVICE_UID and GID $SERVICE_GID: map these for a folder
passed into an LXC container (docs/install.md, "LXC containers").

${YELLOW}Keep a copy of $MASTER_KEY_FILE somewhere apart from the database backups.${RESET}
Without it, the encrypted secrets in a backup (SMB passwords, authenticator apps, SSO and SMTP
secrets) can't be recovered. The daily backups in $DATA_DIR/backups don't include it.

The site listens on 127.0.0.1:8480. Put a TLS reverse proxy in front of it: see docs/install.md,
"Reverse proxy", and the examples in deploy/proxy/ (Caddy and nginx).
EOF
}

# What --apply-update can't do offline and unattended, and an install over SSH can: each missing piece
# stops it with exit 3 (needs-installer) before anything is changed.
check_apply_update() {
  local node_version="$1"
  [[ -f "$(target "$CONFIG_FILE")" ]] || die "there is no $CONFIG_FILE: --apply-update only upgrades an install; run install.sh over SSH."
  [[ -f "$(target "$MASTER_KEY_FILE")" ]] || die "there is no $MASTER_KEY_FILE: install this release over SSH."
  if in_destdir; then
    [[ -n "$(sysusers_file_ids "$(target "$SYSUSERS_FILE")")" ]] || die "there is no service user: install this release over SSH."
    return
  fi
  [[ -n "$(existing_service_ids)" ]] || die "the service user $SERVICE_USER doesn't exist: install this release over SSH."
  check_node "$node_version" || die "there is no $NODE: install this release over SSH."
  command -v mount.cifs >/dev/null || die "cifs-utils is not installed: install this release over SSH, which installs it."
  systemctl cat polkit.service >/dev/null 2>&1 || die "polkit is not installed: install this release over SSH, which installs it."
}

# --apply-update's exit code is the update helper's contract (deployment.md, "The update contracts"): 0
# done, 3 only while nothing was changed, 1 for any other failure, whatever status the command that
# failed had.
apply_update_exit() {
  local status=$?
  ((status == 0)) && return
  ((status == 3)) && "$NOTHING_CHANGED" && exit 3
  exit 1
}

install_main() {
  if "$APPLY_UPDATE"; then
    trap apply_update_exit EXIT
    DIE_STATUS=3
  fi
  BUNDLE=$(locate_bundle)
  RELEASE_SOURCE=$(locate_release)
  VERSION=$(read_bundle_file VERSION '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$')
  local bundle_arch
  bundle_arch=$(read_bundle_file ARCH '^(x64|arm64)$')
  [[ -f "$RELEASE_SOURCE/dist/main.js" ]] || die "the tarball has no release/dist/main.js: download it again."

  local manager="" node_version=""
  if in_destdir; then
    step "Laying NotUnreachable $VERSION out under $DESTDIR (no packages, users or systemd)"
  else
    [[ "$(id -u)" == 0 ]] || die "run it as root, such as with sudo."
    step "Checking this host"
    manager=$(check_distribution /etc/os-release)
    check_systemd_version "$(systemctl --version | head -n 1)"
    check_libc "$(getconf GNU_LIBC_VERSION 2>/dev/null || true)"
    check_arch "$(uname -m)" "$bundle_arch"
    [[ -x "$NODE" ]] && node_version=$("$NODE" --version)
    check_node "$node_version" || true
    # The apply unit that runs --apply-update is the update itself.
    "$APPLY_UPDATE" || hold_updates "$RUNTIME_UNIT_DIR"
  fi
  "$APPLY_UPDATE" && check_apply_update "$node_version"
  # Before the packages: a taken ID stops the install while nothing is changed yet.
  choose_service_id
  DIE_STATUS=1
  NOTHING_CHANGED=false
  in_destdir || "$APPLY_UPDATE" || install_packages "$manager" "$node_version"
  # The apply unit that runs --apply-update holds the lock and the work folder itself. Checked again
  # before the work folder goes: the hold refuses every start, but an update still running keeps it.
  if ! "$APPLY_UPDATE"; then
    in_destdir || refuse_while_updating "Only the packages were installed."
    end_interrupted_update
  fi

  install_system_files
  create_service_user
  make_directories
  create_master_key
  write_config
  sync_switch_rules
  folders_to_allow

  step "Installing release $VERSION in $OPT_DIR/$VERSION"
  local upgraded_from
  upgraded_from=$(install_release)
  # A re-run of the release in use keeps everything, so the release before it stays for a rollback.
  [[ -z "$upgraded_from" ]] || prune_releases "$upgraded_from"

  if in_destdir; then
    :
  elif "$APPLY_UPDATE"; then
    # The update helper restarts the service and checks it; a rollback needs it stopped meanwhile.
    reload_systemd
    check_exposure
  else
    start_service "$upgraded_from"
    check_exposure
  fi
  audit_layout
  if "$APPLY_UPDATE"; then
    printf '\nNotUnreachable %s is installed; the update helper restarts the service.\n' "$VERSION"
  else
    print_finish "$upgraded_from"
  fi
}

# ---------------------------------------------------------------------------------------------------
# Uninstall

uninstall_main() {
  local purge="$1"
  in_destdir || [[ "$(id -u)" == 0 ]] || die "run it as root, such as with sudo."
  if "$purge"; then
    printf '%s--purge deletes the config, the master key and every database backup in %s and %s.%s\n' \
      "$RED" "$CONFIG_DIR" "$DATA_DIR" "$RESET"
    local answer=""
    read -r -p 'Type "delete everything" to go on: ' answer || true
    [[ "$answer" == "delete everything" ]] || die "not confirmed; nothing was removed."
  fi

  if ! in_destdir; then
    step "Stopping NotUnreachable"
    systemctl disable --now "$BACKUP_TIMER" "$SERVICE_UNIT" 2>/dev/null || true
    systemctl stop 'not-unreachable-mount@*.service' "$UPDATE_UNIT" "$UPDATE_APPLY_UNIT" 2>/dev/null || true
  fi
  step "Removing the units, the polkit rules, the CLI, the helpers, $OPT_DIR and $UPDATE_STATE_DIR"
  # Every unit and rule install.sh owns, also those of another release than this one.
  rm -f -- "$(target "$UNIT_DIR")"/not-unreachable*.service "$(target "$UNIT_DIR")"/not-unreachable*.timer \
    "$(target /etc/polkit-1/rules.d)"/5?-not-unreachable*.rules
  rm -f -- "$(target "$CLI_PATH")" "$(target "$TMPFILES_FILE")"
  rm -rf -- "$(target "$HELPER_DIR")" "$(target "$OPT_DIR")" "$(target "$UPDATE_STATE_DIR")"
  # The mount folders are empty once the units stopped; rmdir leaves anything still mounted.
  rmdir -- "$(target "$MOUNTS_DIR")"/* "$(target "$MOUNTS_DIR")" "$(target "$MOUNTS_PARENT")" 2>/dev/null || true

  if "$purge"; then
    step "Removing $CONFIG_DIR, $DATA_DIR, the systemd drop-in and the service user"
    rm -rf -- "$(target "$CONFIG_DIR")" "$(target "$DATA_DIR")" "$(target "$DROP_IN_DIR")" "$(target "$SYSUSERS_FILE")"
    in_destdir || userdel "$SERVICE_USER" 2>/dev/null || true
  fi
  if ! in_destdir; then
    systemctl daemon-reload
    systemctl restart polkit.service 2>/dev/null || true
  fi

  if "$purge"; then
    printf '\nNotUnreachable is removed, with its config and data.\n'
  else
    printf '\nNotUnreachable is removed. Kept: %s (config and master key), %s (database and\n' "$CONFIG_DIR" "$DATA_DIR"
    printf 'backups), the folder list in %s and the service user. Run with --uninstall --purge to\n' "$DROP_IN_DIR"
    printf 'remove those too.\n'
  fi
  printf 'Node.js, cifs-utils and polkit stay installed.\n'
}

# ---------------------------------------------------------------------------------------------------

usage() {
  cat <<'EOF'
Usage: sudo ./install.sh [options]
       sudo ./install.sh --uninstall [--purge]
       sudo ./install.sh --apply-update

Installs NotUnreachable from this release tarball, or upgrades an existing install to it.

Options:
  --public-origin URL   The site's public https address, such as https://files.example.com
                        (asked on a first install when not given).
  --allow-folder PATH   A local folder the service may share; repeat for more (asked on a first
                        install when none is given). Add more later with not-unreachable allow-folder.
  --uid ID              The service user's UID and GID, one number from 1 to 60000 (asked on a first
                        install when not given; 2000 by default). NU_UID=ID does the same. An
                        existing service user keeps its own.
  --yes                 Ask nothing: fail instead when something needed is missing.
  --uninstall           Remove NotUnreachable; keep its config, master key and data.
  --purge               With --uninstall, remove the config, master key and data too (asks you to
                        type a confirmation).
  --apply-update        Upgrade offline and ask nothing, as the update helper does when updating
                        from Settings: no packages, the service neither started nor restarted, no
                        setup link. Exits 0 when done, 3 when it must be installed over SSH instead
                        (nothing was changed), 1 when it failed.
  -h, --help            Show this help.
EOF
}

main() {
  PUBLIC_ORIGIN=""
  ALLOW_FOLDERS=()
  ASSUME_YES=false
  CONFIG_IS_NEW=false
  REQUESTED_SERVICE_ID="${NU_UID:-}"
  SERVICE_UID="" SERVICE_GID=""
  APPLY_UPDATE=false
  NOTHING_CHANGED=true
  local uninstall=false purge=false
  while (($# > 0)); do
    case "$1" in
      --public-origin) (($# >= 2)) || die "--public-origin needs a URL."; PUBLIC_ORIGIN="$2"; shift ;;
      --public-origin=*) PUBLIC_ORIGIN="${1#*=}" ;;
      --allow-folder) (($# >= 2)) || die "--allow-folder needs a path."; ALLOW_FOLDERS+=("$2"); shift ;;
      --allow-folder=*) ALLOW_FOLDERS+=("${1#*=}") ;;
      --uid) (($# >= 2)) || die "--uid needs a number."; REQUESTED_SERVICE_ID="$2"; shift ;;
      --uid=*) REQUESTED_SERVICE_ID="${1#*=}" ;;
      --yes | -y) ASSUME_YES=true ;;
      --uninstall) uninstall=true ;;
      --purge) purge=true ;;
      --apply-update) APPLY_UPDATE=true ASSUME_YES=true ;;
      -h | --help) usage; return 0 ;;
      *) usage >&2; die "unknown option: $1" ;;
    esac
    shift
  done
  if [[ -n "$PUBLIC_ORIGIN" ]] && ! valid_public_origin "$PUBLIC_ORIGIN"; then
    die "--public-origin must be an https origin such as https://files.example.com (no path)."
  fi
  if [[ -n "$REQUESTED_SERVICE_ID" ]] && ! valid_service_id "$REQUESTED_SERVICE_ID"; then
    die "--uid (or NU_UID) must be a number from 1 to $MAX_SERVICE_ID."
  fi
  "$purge" && ! "$uninstall" && die "--purge goes with --uninstall."
  if "$APPLY_UPDATE" && { "$uninstall" || ((${#ALLOW_FOLDERS[@]} > 0)) || [[ -n "$PUBLIC_ORIGIN$REQUESTED_SERVICE_ID" ]]; }; then
    die "--apply-update takes no other option."
  fi

  if "$uninstall"; then
    uninstall_main "$purge"
  else
    install_main
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
