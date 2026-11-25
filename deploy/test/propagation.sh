#!/bin/bash
# The mount propagation test (docs/design/smb.md, "Mount propagation and the hardened service"), run
# as root on a host where install.sh installed NotUnreachable and the service runs, against an SMB
# share (the Install workflow starts a Samba container). It:
#
#   1. starts a mount unit while the service runs, as the service user (so through the polkit rule);
#   2. lists and writes inside the share from the service's own mount namespace, as the service user;
#   3. checks the mount's options (nosuid,nodev,noexec, the forced uid/gid, sign) and the helper
#      unit's capability set;
#   4. stops the unit, and checks the mount is gone on the host and inside the service, and that the
#      service kept running throughout.
#
# SMB_TEST_HOST, SMB_TEST_SHARE, SMB_TEST_USERNAME and SMB_TEST_PASSWORD name the share.
set -euo pipefail

readonly SERVICE_USER=not-unreachable
readonly SERVICE_UNIT=not-unreachable.service
readonly MOUNTS_DIR=/srv/not-unreachable/mounts
readonly REQUEST_DIR=/run/not-unreachable/mount-requests
readonly ID=7d3c6a52-1f0e-4b8a-9c6d-2e5f4a3b1c0d
readonly UNIT="not-unreachable-mount@$ID.service"
readonly MOUNT_POINT="$MOUNTS_DIR/$ID"

: "${SMB_TEST_HOST:?}" "${SMB_TEST_SHARE:?}" "${SMB_TEST_USERNAME:?}" "${SMB_TEST_PASSWORD:?}"

fail() {
  printf '::error::%s\n' "$*" >&2
  exit 1
}
step() { printf '==> %s\n' "$*"; }

uid=$(id -u "$SERVICE_USER")
gid=$(id -g "$SERVICE_USER")
as_service_user() { runuser -u "$SERVICE_USER" -- "$@"; }

service_pid() { systemctl show --property=MainPID --value "$SERVICE_UNIT"; }

# Runs a command inside the service's mount namespace, as the service user.
in_service() {
  nsenter --target "$SERVICE_PID" --mount -- \
    setpriv --reuid="$uid" --regid="$gid" --clear-groups --inh-caps=-all -- "$@"
}

cleanup() {
  systemctl stop "$UNIT" 2>/dev/null || true
  rm -f -- "$REQUEST_DIR/$ID.json"
}
trap cleanup EXIT

systemctl is-active --quiet "$SERVICE_UNIT" || fail "$SERVICE_UNIT is not running"
SERVICE_PID=$(service_pid)
[[ "$SERVICE_PID" -gt 0 ]] || fail "$SERVICE_UNIT has no main process"

step "1. Starting $UNIT as $SERVICE_USER while the service runs (pid $SERVICE_PID)"
as_service_user mkdir -p -m 0700 "$REQUEST_DIR"
request=$(printf '{"host":"%s","share":"%s","subfolder":"","username":"%s","password":"%s","domain":"","vers":"3.1.1","seal":true}' \
  "$SMB_TEST_HOST" "$SMB_TEST_SHARE" "$SMB_TEST_USERNAME" "$SMB_TEST_PASSWORD")
# shellcheck disable=SC2016 # the inner script expands its own $0.
as_service_user bash -c 'umask 077 && cat > "$0"' "$REQUEST_DIR/$ID.json" <<<"$request"
as_service_user systemctl start "$UNIT" || {
  journalctl --no-pager -u "$UNIT" | tail -n 20 >&2
  fail "the service user could not start $UNIT"
}
findmnt --types cifs --mountpoint "$MOUNT_POINT" >/dev/null || fail "$MOUNT_POINT is not a cifs mount on the host"

step "2. Listing and writing inside the share from the service's namespace"
in_service findmnt --types cifs --mountpoint "$MOUNT_POINT" >/dev/null ||
  fail "the mount did not propagate into the service's namespace"
in_service ls -la "$MOUNT_POINT" >/dev/null || fail "the service user can't list $MOUNT_POINT inside the service"
probe="$MOUNT_POINT/propagation-probe-$$"
# shellcheck disable=SC2016 # the inner script expands its own $0.
in_service bash -c 'printf probe > "$0" && [[ "$(cat "$0")" == probe ]] && rm -- "$0"' "$probe" ||
  fail "the service user can't write $probe inside the service"

step "3. Checking the mount options and the helper's capabilities"
options=$(findmnt --noheadings --output OPTIONS --mountpoint "$MOUNT_POINT")
printf '    %s\n' "$options"
for option in nosuid nodev noexec forceuid forcegid "uid=$uid" "gid=$gid" sign; do
  [[ ",$options," == *",$option,"* ]] || fail "the mount lacks $option"
done
capabilities=$(systemctl show --property=CapabilityBoundingSet --value "$UNIT")
[[ "$(tr ' ' '\n' <<<"$capabilities" | sort | xargs)" == "cap_dac_override cap_dac_read_search cap_sys_admin" ]] ||
  fail "$UNIT's capability bounding set is \"$capabilities\""

step "4. Stopping $UNIT and checking the mount is gone on both sides"
as_service_user systemctl stop "$UNIT" || fail "the service user could not stop $UNIT"
if findmnt --mountpoint "$MOUNT_POINT" >/dev/null; then fail "$MOUNT_POINT is still mounted on the host"; fi
if in_service findmnt --mountpoint "$MOUNT_POINT" >/dev/null; then fail "$MOUNT_POINT is still mounted inside the service"; fi
[[ ! -e "$MOUNT_POINT" ]] || fail "the mount point $MOUNT_POINT was left behind"
[[ "$(service_pid)" == "$SERVICE_PID" ]] || fail "$SERVICE_UNIT restarted during the test"

step "Mount propagation works: the service saw the share come and go."
