#!/bin/bash
# Installs a release tarball on AlmaLinux 9 with SELinux enforcing, in a QEMU VM, then runs the
# mount propagation test there (the Install workflow's job `install-selinux`; docs/design/smb.md,
# "Mount propagation and the hardened service"). It uses KVM when /dev/kvm is there and says so when it falls back to
# plain emulation, which is far slower. The SMB share is the Samba container on the runner, which
# the VM reaches as 10.0.2.2 (QEMU's user network).
#
#   selinux-vm.sh <release tarball> <work dir>
#
# SMB_TEST_SHARE, SMB_TEST_USERNAME and SMB_TEST_PASSWORD name the share. It needs qemu-system-x86,
# qemu-utils and cloud-image-utils.
set -euo pipefail

(($# == 2)) || {
  sed -n '8p' "$0" >&2
  exit 2
}
tarball="$1" work="$2"
[[ -f "$tarball" ]] || { echo "error: $tarball is missing" >&2; exit 1; }
: "${SMB_TEST_SHARE:?}" "${SMB_TEST_USERNAME:?}" "${SMB_TEST_PASSWORD:?}"

readonly IMAGE_BASE=https://repo.almalinux.org/almalinux/9/cloud/x86_64/images
readonly IMAGE=AlmaLinux-9-GenericCloud-latest.x86_64.qcow2
readonly SSH_PORT=2222
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
name=$(basename "$tarball" .tar.gz)
mkdir -p "$work"

echo "==> Downloading $IMAGE and checking it against AlmaLinux's CHECKSUM"
curl -fsSL --retry 3 -o "$work/$IMAGE" "$IMAGE_BASE/$IMAGE"
curl -fsSL --retry 3 -o "$work/CHECKSUM" "$IMAGE_BASE/CHECKSUM"
# CHECKSUM lists "SHA256 (<file>) = <hash>" lines, which sha256sum reads as they are.
(cd "$work" && grep -F "($IMAGE)" CHECKSUM | sha256sum --check --strict -)
qemu-img create -f qcow2 -F qcow2 -b "$work/$IMAGE" "$work/disk.qcow2" 20G >/dev/null

ssh-keygen -q -t ed25519 -N '' -f "$work/id_ed25519" <<<y >/dev/null
cat >"$work/user-data" <<EOF
#cloud-config
users:
  - name: tester
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh_authorized_keys:
      - $(cat "$work/id_ed25519.pub")
EOF
printf 'instance-id: not-unreachable-test\nlocal-hostname: alma9\n' >"$work/meta-data"
cloud-localds "$work/seed.iso" "$work/user-data" "$work/meta-data"

accel=(-accel kvm -cpu host)
if [[ ! -w /dev/kvm ]]; then
  echo "::warning::/dev/kvm is not available: the AlmaLinux 9 VM runs under plain QEMU emulation"
  accel=(-accel tcg -cpu max)
fi
qemu-system-x86_64 "${accel[@]}" -m 4096 -smp 2 -nographic -serial "file:$work/console.log" \
  -drive "file=$work/disk.qcow2,if=virtio" -drive "file=$work/seed.iso,if=virtio,format=raw" \
  -nic "user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:$SSH_PORT-:22" \
  -daemonize -pidfile "$work/qemu.pid"
trap 'kill "$(cat "$work/qemu.pid")" 2>/dev/null || true' EXIT

# A throwaway VM on a loopback port: its host key is new each run.
ssh_options=(-i "$work/id_ed25519" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
  -o LogLevel=ERROR -o ConnectTimeout=5)
vm() { ssh "${ssh_options[@]}" -p "$SSH_PORT" tester@127.0.0.1 "$@"; }
copy() { scp "${ssh_options[@]}" -P "$SSH_PORT" "$@"; }

echo "==> Waiting for the VM"
for _ in $(seq 120); do
  vm true 2>/dev/null && break
  sleep 5
done
vm cloud-init status --wait >/dev/null
[[ "$(vm getenforce)" == Enforcing ]] || { echo "::error::SELinux is not enforcing in the VM" >&2; exit 1; }

echo "==> Installing $name"
copy "$tarball" "$here/propagation.sh" tester@127.0.0.1:
vm "tar --extract --gzip --file $name.tar.gz && cd $name && sudo ./install.sh --public-origin https://files.example.com --yes"

echo "==> Running the propagation test against the runner's Samba"
vm "sudo SMB_TEST_HOST=10.0.2.2 SMB_TEST_SHARE='$SMB_TEST_SHARE' SMB_TEST_USERNAME='$SMB_TEST_USERNAME' \
  SMB_TEST_PASSWORD='$SMB_TEST_PASSWORD' bash ./propagation.sh"

echo "==> Checking for SELinux denials"
denials=$(vm "sudo ausearch --message AVC,USER_AVC --start boot 2>/dev/null || true")
if grep -q 'denied' <<<"$denials"; then
  echo "::error::SELinux denied something during the install or the propagation test:" >&2
  printf '%s\n' "$denials" >&2
  exit 1
fi
echo "==> AlmaLinux 9 (SELinux enforcing) passed"
