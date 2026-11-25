#!/bin/bash
# Installs a release tarball in a distribution's container booted with systemd, and checks that the
# service runs and the setup link is printed (the Install workflow's job `install-containers`;
# docs/design/deployment.md). The container is privileged, so the unit's sandbox (namespaces,
# seccomp, capabilities) works as on a host. It runs no mount propagation test: the jobs
# install-ubuntu and install-selinux run that.
#
#   systemd-container.sh <debian-12|fedora-43> <release tarball>
set -euo pipefail

(($# == 2)) || {
  sed -n '8p' "$0" >&2
  exit 2
}
distribution="$1" tarball="$2"
[[ -f "$tarball" ]] || { echo "error: $tarball is missing" >&2; exit 1; }

# Pinned base images; each gets systemd as its init, which the distributions' images leave out.
case "$distribution" in
  debian-12)
    base=docker.io/library/debian:12.12
    prepare='apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends systemd systemd-sysv dbus procps && apt-get clean'
    ;;
  fedora-43)
    base=registry.fedoraproject.org/fedora:43
    prepare='dnf install -y -q systemd dbus-broker procps-ng && dnf clean all'
    ;;
  *) echo "error: unknown distribution $distribution" >&2; exit 1 ;;
esac

image="not-unreachable-test-$distribution"
container="not-unreachable-test-$distribution"
name=$(basename "$tarball" .tar.gz)

docker build --tag "$image" - <<EOF
FROM $base
RUN $prepare
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
EOF

cleanup() {
  local status=$?
  ((status == 0)) || docker exec "$container" journalctl --no-pager -n 200 -u 'not-unreachable*' >&2 || true
  docker rm --force "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --detach --name "$container" --privileged --cgroupns=private \
  --tmpfs /run --tmpfs /run/lock --tmpfs /tmp "$image" >/dev/null
in_container() { docker exec "$container" "$@"; }

echo "==> Waiting for systemd in $distribution"
# shellcheck disable=SC2016 # the inner script expands its own $0.
timeout 120 bash -c 'until [[ "$(docker exec "$0" systemctl is-system-running 2>/dev/null)" =~ ^(running|degraded)$ ]]; do
  sleep 2
done' "$container"

echo "==> Installing $name"
docker cp "$tarball" "$container:/root/$name.tar.gz"
in_container tar --extract --gzip --file "/root/$name.tar.gz" --directory /root
in_container bash -c "cd /root/$name && ./install.sh --public-origin https://files.example.com --yes" |
  tee "/tmp/install-$distribution.log"

echo "==> Checking the install"
grep -qE '^  https://files\.example\.com/setup#[A-Za-z0-9_-]{43}$' "/tmp/install-$distribution.log" || { echo "::error::no setup link was printed" >&2; exit 1; }
in_container systemctl is-active --quiet not-unreachable.service
in_container systemctl is-enabled --quiet not-unreachable-backup.timer
in_container getent passwd not-unreachable | grep -qE ':(/usr/sbin/nologin|/sbin/nologin)$'
# The fixed default ID (docs/install.md, "The service user's ID").
ids=$(in_container bash -c 'printf "%s:%s" "$(id -u not-unreachable)" "$(getent group not-unreachable | cut -d: -f3)"')
[[ "$ids" == 2000:2000 ]] || { echo "::error::the service user has UID:GID $ids, not 2000:2000" >&2; exit 1; }
# Type=notify: the service is listening once it is active.
in_container bash -c 'exec 3<>/dev/tcp/127.0.0.1/8480'

echo "==> Re-running the installer: the master key and the service user's ID must stay"
key_before=$(in_container sha256sum /etc/not-unreachable/credentials/master.key)
# Another ID asked for on a re-run is not taken: the existing user keeps its own.
in_container bash -c "cd /root/$name && NU_UID=3000 ./install.sh --yes" >/dev/null
key_after=$(in_container sha256sum /etc/not-unreachable/credentials/master.key)
[[ "$key_before" == "$key_after" ]] || { echo "::error::a re-run changed master.key" >&2; exit 1; }
[[ "$(in_container id -u not-unreachable)" == 2000 ]] || { echo "::error::a re-run changed the service user's UID" >&2; exit 1; }

echo "==> $distribution passed"
