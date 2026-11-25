# Deployment

The target is one Linux host with systemd ≥ 252 (Debian 12+, Ubuntu 24.04+,
Fedora 40+, RHEL, AlmaLinux or Rocky 9+), x86-64 or arm64, with glibc. The app
runs as one process behind a TLS reverse proxy. `deploy/install.sh` (the
**Install** Task, Task 1e20d309-2836-46ce-be58-757b7307d1f2) builds what this
file describes, and `docs/install.md` is its guide; the **Skeleton** Task (Task
94776ed7-0244-4ba0-bd52-a6cfbac33271) implements config loading as specified here.

## Config, secrets and data

`deploy/install.sh` makes every path below with this owner and mode, and its
last step checks them all (the *mode audit*): the install fails on any
difference. `deploy/install/` tests that the script's list and this table
agree.

| Path | Owner | Mode | Holds |
|---|---|---|---|
| `/opt/not-unreachable/` | `root:root` | `0755` | The releases, one folder each. |
| `/opt/not-unreachable/<version>/` | `root:root` | `0755` | A release (server, web build, migrations, production `node_modules`). Read-only: everything in it belongs to root and nothing is writable by group or others. The one before `current` is kept for rollback, older ones are removed. |
| `/opt/not-unreachable/<version>/installer/` | `root:root` | `0755` | That release's own installer (`install.sh`, `deploy/`, `VERSION`, `ARCH`), kept so a rollback can put that release's system files back (see [Updating from Settings](#updating-from-settings)). |
| `/opt/not-unreachable/<version>/release-signing-keys/` | `root:root` | `0755` | The release signing public keys that release trusts, `<key id>.pem` each (see [Release signing](#release-signing)). |
| `/opt/not-unreachable/current` | `root:root` | symlink | The release in use, switched atomically (a new symlink renamed over the old). |
| `/usr/local/bin/not-unreachable` | `root:root` | `0755` | The CLI wrapper (`migrate`, `setup-link`, `reset-admin`, `rotate-key`, `backup`, `allow-folder`, `allow-folders-from-ui`, `update-from-ui`, `update-recover`), for root only. `allow-folder`, `allow-folders-from-ui`, `update-from-ui`, `update-recover` and `rotate-key` run as root; the others run as the service user (below). |
| `/usr/lib/not-unreachable/` | `root:root` | `0755` | The mount and folder helpers' folder. |
| `/usr/lib/not-unreachable/mount-helper.mjs` | `root:root` | `0644` | The SMB mount helper, run by `/usr/bin/node` (see [smb.md](smb.md)). |
| `/usr/lib/not-unreachable/request-file.mjs` | `root:root` | `0644` | Reads a request file the service wrote; shared by both helpers. |
| `/usr/lib/not-unreachable/folder-access.mjs` | `root:root` | `0644` | The folder checks and the `resources.conf` writer, shared by the folder helper and `allow-folder`. |
| `/usr/lib/not-unreachable/folder-helper.mjs` | `root:root` | `0644` | The folder helper (see [Allowing folders from the admin interface](#allowing-folders-from-the-admin-interface)). |
| `/usr/lib/not-unreachable/51-not-unreachable-allow-folder.rules` | `root:root` | `0644` | The shipped copy of the allow-folder polkit rule, which `allow-folders-from-ui on` and the install copy into `/etc/polkit-1/rules.d/`. Not active here. |
| `/usr/lib/not-unreachable/update-helper.mjs` | `root:root` | `0644` | The update helper, run by both update units (see [Updating from Settings](#updating-from-settings)), with the modules it imports (`release-verify.mjs`, `release-archive.mjs`). |
| `/usr/lib/not-unreachable/52-not-unreachable-update.rules` | `root:root` | `0644` | The shipped copy of the update polkit rule, which `update-from-ui on` and the install copy into `/etc/polkit-1/rules.d/`. Not active here. |
| `/etc/not-unreachable/` | `root:root` | `0755` | Config. |
| `/etc/not-unreachable/config.env` | `root:not-unreachable` | `0640` | Bootstrap config (below). Written once by the install; a re-run keeps it. |
| `/etc/not-unreachable/credentials/` | `root:root` | `0700` | Secrets for `LoadCredential=`. |
| `/etc/not-unreachable/credentials/master.key` | `root:root` | `0600` | 32 bytes from `/dev/urandom`, made at install only if missing; a re-run never touches it. Given to the service by `LoadCredential=`. |
| `/var/lib/not-unreachable/` | `not-unreachable:not-unreachable` | `0700` | Data (`StateDirectory`). |
| `/var/lib/not-unreachable/db/` | `not-unreachable:not-unreachable` | `0700` | The database folder. |
| `/var/lib/not-unreachable/db/not-unreachable.sqlite` (+ `-wal`, `-shm`) | `not-unreachable:not-unreachable` | `0600` | The database, made by the first start. |
| `/var/lib/not-unreachable/uploads/` | `not-unreachable:not-unreachable` | `0700` | tus staging. |
| `/var/lib/not-unreachable/backups/` | `not-unreachable:not-unreachable` | `0700` | Pre-migration and scheduled backups. |
| `/var/lib/not-unreachable/updates/` | `not-unreachable:not-unreachable` | `0700` | The spool: the release files the server downloaded for the update helper. Emptied once the helper has copied them. |
| `/var/lib/not-unreachable-update/` | `root:root` | `0755` | The update units' state (`StateDirectory`). Readable by all, so the service can read `status.json`. |
| `/var/lib/not-unreachable-update/status.json` | `root:root` | `0644` | The last update's status (schema in [The update contracts](#the-update-contracts)). Optional: there is none before the first update. |
| `/var/lib/not-unreachable-update/work/` | `root:root` | `0700` | The lock, the helper's private copies of the spool files and the staged release. |
| `/srv/not-unreachable/` | `root:root` | `0755` | Parent of the mount root (tmpfiles). |
| `/srv/not-unreachable/mounts/` | `root:root` | `0755` | SMB mount points, `<resourceId>/` each, made by the helper. Root-owned, so the helper never acts inside a directory the service controls. Inside a mount, everything belongs to the service user (`forceuid`, `dir_mode=0750`). |
| `/run/not-unreachable/` | `not-unreachable:not-unreachable` | `0700` | Mount and folder request files (short-lived), while the service runs (`RuntimeDirectory`). |
| `/run/not-unreachable-mount/` | `root:root` | `0700` | The helper's short-lived credentials files, made again at every boot (tmpfiles). |
| `/etc/systemd/system/not-unreachable.service` | `root:root` | `0644` | The service (below). |
| `/etc/systemd/system/not-unreachable-backup.service` | `root:root` | `0644` | The daily backup (see [Backups](#backups)). |
| `/etc/systemd/system/not-unreachable-backup.timer` | `root:root` | `0644` | Runs it daily. |
| `/etc/systemd/system/not-unreachable-mount@.service` | `root:root` | `0644` | The mount helper's unit (see [smb.md](smb.md#what-happens-underneath)). |
| `/etc/systemd/system/not-unreachable-allow-folder.service` | `root:root` | `0644` | The folder helper's unit (see [Allowing folders from the admin interface](#allowing-folders-from-the-admin-interface)). |
| `/etc/systemd/system/not-unreachable-update.service` | `root:root` | `0644` | The update helper's verify unit (see [Updating from Settings](#updating-from-settings)). |
| `/etc/systemd/system/not-unreachable-update-apply.service` | `root:root` | `0644` | The update helper's apply unit. |
| `/etc/systemd/system/not-unreachable.service.d/` | `root:root` | `0755` | The service's drop-ins: `resources.conf` (below). Made by the install, as the folder helper's unit can't start without it. |
| `/etc/polkit-1/rules.d/50-not-unreachable.rules` | `root:root` | `0644` | Lets the service user start and stop its mount units, nothing else. |
| `/etc/polkit-1/rules.d/51-not-unreachable-allow-folder.rules` | `root:root` | `0644` | Lets the service user start the folder helper's unit, nothing else. Present only while `ALLOW_FOLDERS_FROM_UI=true`; the audit checks it only when it is there. |
| `/etc/polkit-1/rules.d/52-not-unreachable-update.rules` | `root:root` | `0644` | Lets the service user start the update helper's verify unit, nothing else. Present only while `UPDATE_FROM_UI=true`; the audit checks it only when it is there. |
| `/usr/lib/sysusers.d/not-unreachable.conf` | `root:root` | `0644` | The service user: a system user and group with a fixed UID and GID (2000 by default; [install.md, "The service user's ID"](../install.md#the-service-users-id)), home `/`, shell `/usr/sbin/nologin`, password locked. |
| `/usr/lib/tmpfiles.d/not-unreachable.conf` | `root:root` | `0644` | `/run/not-unreachable-mount` and `/srv/not-unreachable/mounts`. |

Not in the audit: `/etc/systemd/system/not-unreachable.service.d/resources.conf`,
which `allow-folder` and the folder helper write (below), and journald, which holds the logs
(`journalctl -u not-unreachable`).

**The CLI as the service user.** `migrate`, `backup`, `setup-link` and
`reset-admin` run through `systemd-run --wait --collect` (`--pty` on a
terminal, so `reset-admin` can ask to confirm, `--pipe` otherwise) as
`not-unreachable`, with the service's sandbox, `config.env` and
`LoadCredential=master.key`. So they see what the service sees, the files they
make belong to the service user, and the key file stays root-only. The
transient unit leaves out `RuntimeDirectory=` (stopping it would remove the
running service's `/run/not-unreachable`) and `RemoveIPC=`.
`allow-folders-from-ui` and `update-from-ui` are done by the wrapper alone (see
[Allowing folders from the admin
interface](#allowing-folders-from-the-admin-interface) and [Updating from
Settings](#updating-from-settings)); `update-recover` starts the apply unit.
`rotate-key` runs as root, refuses while the service runs, and gives the files it made in
`/var/lib/not-unreachable` back to the service user afterwards. `rotate-key`
also refuses unless `fs.protected_hardlinks` is 1, so the service user can't
plant a hard link to a root-owned file for that `chown` to hand over.

**Bootstrap config** (`config.env`, validated by a zod schema at startup; the
server refuses to start and names the bad key if anything is wrong). Everything
else is a setting in the admin interface, stored in the database.

| Key | Default | Meaning |
|---|---|---|
| `PUBLIC_ORIGIN` | *(required)* | e.g. `https://files.example.com`. Must be `https://` unless the host is `localhost`. Used for cookies, CSRF, WebAuthn RP ID, SSO redirect URIs and links in emails. |
| `LISTEN_HOST` | `127.0.0.1` | Bind address. |
| `LISTEN_PORT` | `8480` | Bind port. |
| `TRUSTED_PROXIES` | `127.0.0.1,::1` | Comma-separated IPs/CIDRs whose `X-Forwarded-For` and `X-Forwarded-Proto` are believed. Never `*`. |
| `DATA_DIR` | `/var/lib/not-unreachable` | Data root. |
| `LOG_LEVEL` | `info` | pino level. |
| `HSTS_INCLUDE_SUBDOMAINS` | `false` | See the threat model, T13. |
| `ALLOW_FOLDERS_FROM_UI` | `false` | Whether the admin may allow local folders from the admin interface (see [Allowing folders from the admin interface](#allowing-folders-from-the-admin-interface)). A new install writes `false`; an existing config is never changed, so an upgrade never turns it on. Switch it with `not-unreachable allow-folders-from-ui on\|off`, not by hand, as that also installs or removes the polkit rule. |
| `UPDATE_CHECK` | `true` | Whether the server asks GitHub for the latest release, to show it in **Settings → Updates** (see [Updating from Settings](#updating-from-settings)). `false` for an air-gapped host: the server then makes no request to GitHub at all, and nothing can be installed from Settings. |
| `UPDATE_FROM_UI` | `false` | Whether the admin may install a newer release from **Settings → Updates**. A new install writes `false`; an existing config is never changed, so an upgrade never turns it on. Switch it with `not-unreachable update-from-ui on\|off`, not by hand, as that also installs or removes the polkit rule. |
| `ALLOWED_FOLDER_PREFIXES` | `/srv,/mnt` | Comma-separated folders inside which the admin interface may allow a folder. Each must be absolute and normalised, with no trailing slash; never `/`, and never a system folder (`/etc`, `/usr`, `/var`, `/opt`, `/run` and the like), inside one or holding one. An empty list is invalid. Doesn't limit `allow-folder`. |

## systemd unit

`/etc/systemd/system/not-unreachable.service`, installed from
`deploy/systemd/not-unreachable.service`. That file is this text plus a
two-line header comment, and `deploy/install/` fails if the two differ:

```ini
[Unit]
Description=NotUnreachable file sharing
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=notify
NotifyAccess=all
User=not-unreachable
Group=not-unreachable
WorkingDirectory=/opt/not-unreachable/current
ExecStart=/usr/bin/node --disable-proto=delete dist/main.js
EnvironmentFile=/etc/not-unreachable/config.env
Environment=NODE_ENV=production
LoadCredential=master.key:/etc/not-unreachable/credentials/master.key
StateDirectory=not-unreachable
StateDirectoryMode=0700
RuntimeDirectory=not-unreachable
RuntimeDirectoryMode=0700
UMask=0077
Restart=on-failure
RestartSec=5s
TimeoutStopSec=30s

# Hardening
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
ProcSubset=pid
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RemoveIPC=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @mount
# V8's JIT needs writable+executable memory, so MemoryDenyWriteExecute stays off.
MemoryDenyWriteExecute=no
ReadWritePaths=/srv/not-unreachable/mounts
# Local folders the admin maps are added in a drop-in (resources.conf, below)
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

- `Type=notify`: the server sends `READY=1` to `NOTIFY_SOCKET` only after
  migrations ran and it listens, so `systemctl start` reports a failed
  migration. Node cannot send an `AF_UNIX` datagram without a native module,
  so the server runs `systemd-notify --ready` (no shell). That message comes
  from a child process, which `NotifyAccess=main` would drop, hence
  `NotifyAccess=all`. Only the service's own processes share its cgroup.
- **Local folders**: `ProtectSystem=strict` makes the whole file system
  read-only for the service. A local folder the admin maps must be listed in
  `ReadWritePaths=` (or `ReadOnlyPaths=`) through a drop-in,
  `/etc/systemd/system/not-unreachable.service.d/resources.conf`. The install
  script asks for these folders, and `not-unreachable allow-folder <path>`
  (root) adds one later and restarts the service. The **Add resource → Local
  folder** screen checks that the path is writable and, if not, shows the
  exact command to run. With `ALLOW_FOLDERS_FROM_UI=true` it also offers
  **Allow this folder**, which does the same from the admin interface for a
  folder inside `ALLOWED_FOLDER_PREFIXES` (see [Allowing folders from the admin
  interface](#allowing-folders-from-the-admin-interface)); off, the default,
  only the command is shown. *Rejected:* letting the service write anywhere
  (`ProtectSystem=full`), which throws away most of the hardening for one
  convenience.
- `ProtectHome=yes` hides `/home`, `/root` and `/run/user`. Mapping a folder
  under `/home` needs `ProtectHome=tmpfs` plus `BindPaths=`; the drop-in tool
  handles that case.
- `allow-folder <path>` checks the path as the server does (absolute, an
  existing folder by its real path, neither inside nor containing `DATA_DIR`,
  `/opt/not-unreachable` or `/srv/not-unreachable/mounts`; the checks and the
  writer are `folder-access.mjs`, shared with the folder helper), then rewrites
  `resources.conf` atomically (temporary file, `fsync`, rename) with every
  folder it already listed plus the new one, so running it twice changes
  nothing. Then it runs `systemctl daemon-reload` and `systemctl restart
  not-unreachable.service`. For a folder under `/home`, `/root` or
  `/run/user`, the drop-in also gets `ProtectHome=tmpfs` and a `BindPaths=`
  line for it:

  ```ini
  # Managed by `not-unreachable allow-folder`, which rewrites this file: add folders with it, not by hand.
  # (more comment lines)
  [Service]
  ReadWritePaths=/home/alice/shared
  ReadWritePaths=/srv/media
  ProtectHome=tmpfs
  BindPaths=/home/alice/shared
  ```
- The install script runs `systemd-analyze security not-unreachable.service`
  after it starts the service (so with the `resources.conf` drop-in) and fails
  if the exposure score is above 2.0, above 1.5 for the folder helper's
  unit and the update helper's verify unit, and above 3.0 for its apply unit
  (see [Updating from Settings](#updating-from-settings)). `deploy/install/` runs the same checks offline on the unit files, and
  `systemd-analyze verify` on the units, where `systemd-analyze` is installed.
- `WorkingDirectory` is the release root that `pnpm deploy` writes (see
  [stack.md](stack.md#release-artefact)), so the entry point is `dist/main.js`.
- The mount helper's unit, `not-unreachable-mount@.service`, runs as root and
  must stay in the host's mount namespace, so it can't use `ProtectSystem=`,
  `ProtectHome=`, `PrivateTmp=` or any other directive that would give it a
  namespace of its own; a mount made there would never reach the host. Its
  hardening without one is listed in [smb.md](smb.md#what-happens-underneath).
  It has no `[Install]` section: it is never enabled, only started and stopped
  by the service through polkit.
- **The backup units.** `not-unreachable-backup.service` (`Type=oneshot`) runs
  `dist/cli.js backup` as the service user, with the same `config.env`,
  `LoadCredential=master.key` and hardening as the service, so it sees what the
  service sees. It leaves out `RuntimeDirectory=` (stopping it would remove the
  service's `/run/not-unreachable`), `RemoveIPC=` (it would remove the running
  service's IPC objects, which belong to the same user) and the mount root's
  `ReadWritePaths=`. `not-unreachable-backup.timer` starts it (see
  [Backups](#backups)). `deploy/install/` checks that its settings are the
  service's, minus those.
- **The CLI wrapper** (`/usr/local/bin/not-unreachable`) runs `dist/cli.js`
  in a transient unit (see [Config, secrets and data](#config-secrets-and-data)).
  Its sandbox for the service-user commands is a copy of this unit's
  `[Service]` settings minus those that belong to the long-running service
  alone; `deploy/install/` checks the copy against the unit.

### Allowing folders from the admin interface

Opt-in, off by default (`ALLOW_FOLDERS_FROM_UI=false`). While it is off,
nothing below is reachable: the route is not registered (404), no polkit rule
lets the service user start the folder helper, and the helper refuses anyway.

- **The switch.** `sudo not-unreachable allow-folders-from-ui on|off` rewrites
  `ALLOW_FOLDERS_FROM_UI=` in `config.env` (temporary file, rename, same owner
  and mode), installs or removes
  `/etc/polkit-1/rules.d/51-not-unreachable-allow-folder.rules` from the copy
  in `/usr/lib/not-unreachable/`, restarts polkit and runs `systemctl
  try-restart not-unreachable.service`, so the service reads the switch (a
  service stopped on purpose stays stopped). Off removes the rule first. Every
  install and upgrade syncs the rule with the switch the same way, so a rule
  left behind by hand goes when the switch is off. *Decision:* the rule exists
  only while the switch is on, rather than always present with the helper
  refusing; the helper still checks the switch itself, as a second line.
- **The rule** lets the service user `start` exactly
  `not-unreachable-allow-folder.service`: no other unit, verb or action.
- **The unit**, `not-unreachable-allow-folder.service` (`Type=oneshot`, no
  `[Install]`), runs `/usr/bin/node /usr/lib/not-unreachable/folder-helper.mjs
  allow` as root, with `CapabilityBoundingSet=CAP_DAC_READ_SEARCH` only. It
  only writes a file and talks to PID 1, so unlike the mount helper it gets
  the full sandbox: `ProtectSystem=strict` with `ReadWritePaths=` on the
  drop-in folder alone, `ProtectHome=read-only`, `PrivateTmp=`,
  `PrivateDevices=`, `PrivateNetwork=`, `IPAddressDeny=any`,
  `RestrictAddressFamilies=AF_UNIX`, `SystemCallFilter=@system-service
  ~@privileged @mount` and the rest of the service's settings. The install
  fails if its exposure is above 1.5.
- **The request.** The server writes
  `/run/not-unreachable/folder-requests/allow-folder.json` (service user,
  `0600`, under 8 KiB), starts the unit and deletes the file afterwards. The
  helper reads it as the mount helper reads its own (`O_NOFOLLOW` through the
  pinned directory, then owner, mode, size and type checked on the
  descriptor); everything in it is untrusted.
- **The helper's checks.** It reads `config.env` itself (root's regular file,
  not writable by group or others) and refuses unless `ALLOW_FOLDERS_FROM_UI`
  is `true`. Then the path: absolute; its real path exists and is a folder;
  only characters a drop-in can list; not a system folder, nor inside or
  holding one; inside one of `ALLOWED_FOLDER_PREFIXES`, compared after
  resolving symlinks; neither inside nor holding `DATA_DIR`,
  `/opt/not-unreachable` or `/srv/not-unreachable/mounts`; and neither inside
  nor holding a folder `resources.conf` lists already, as written or by its
  real path. The service can write in a listed folder, so it could swap a
  folder below one for a symlink, which systemd follows at the next start;
  only the helper applies this rule, so the server's check can't tell
  beforehand. It then writes
  `resources.conf` with the same code as `allow-folder`, runs `systemctl
  daemon-reload`, and schedules `systemctl restart not-unreachable.service`
  3 seconds later through `systemd-run`, so the server can answer and audit
  first. The result is its exit code, one per reason (`folder-helper.mts`).
- **The server.** `POST /api/v1/admin/resources/allowed-folders`, admin only,
  takes the path, the admin's password and an authenticator code or passkey
  answer, every time: a recent sign-in is not enough. Both factors are checked
  as at sign-in, under the same try limits (threat model, T10, T11); the path
  is checked only once both passed, then again by the helper. 5 requests per
  account per 15 minutes. Each request records one `folder.allowed` (path,
  real path, result); a success also emails the admin a security notice.
  Problem bodies and logs never hold the path.
- **The admin interface.** **Allow this folder**, beside the command on **Add
  resource → Local folder**, asks for the password and a second factor, then
  shows that the service is restarting, waits for `/api/v1/health`, checks
  the folder again and goes on with the Add.

## TLS and the reverse proxy

The app speaks plain HTTP on loopback and never terminates TLS itself. The
reverse proxy terminates TLS, sets `X-Forwarded-For` and `X-Forwarded-Proto`,
and forwards everything to `127.0.0.1:8480`.

**Trusted proxy handling.** Fastify's `trustProxy` is set to the
`TRUSTED_PROXIES` list, never to `true`. So `request.ip` is the client address
the proxy reports, and only when the connection comes from a listed proxy. A
request that arrives straight on the port from anywhere else keeps its socket
address, and its forwarded headers are ignored. `request.protocol` must be
`https` for every request except from loopback in development: the server
answers 400 otherwise. Combined with `PUBLIC_ORIGIN` being `https://`, cookies
are always set `Secure`, with no per-request guessing.

**Body size and timeouts**: the proxy must allow request bodies of at least the
tus chunk size (64 MiB) and must not buffer them, and its read timeout must
cover long downloads.

### Caddy (recommended: automatic certificates)

```caddyfile
files.example.com {
	encode zstd gzip
	request_body {
		max_size 64MiB
	}
	reverse_proxy 127.0.0.1:8480 {
		flush_interval -1
	}
	# Share-link, invitation and re-link tokens are in the path, the SSO callback's code in the query.
	# The path matcher compares the decoded path, so a percent-encoded URL can't slip past it.
	@bearer_token path /s/* /api/v1/public/share-links/* /invitation/* /relink/* /api/v1/invitations/* /api/v1/relink/* /api/v1/sso/*/callback
	log_skip @bearer_token
	log {
		output file /var/log/caddy/not-unreachable.log
	}
}
```

Caddy sends `X-Forwarded-For` and `X-Forwarded-Proto` by default.
`log_skip` needs Caddy 2.8 or later. Both examples leave every URL that
carries a token out of the access log: the paths the app's own logger redacts
(`platform/logger.ts`), matched on the decoded path; `deploy/install/` checks
both against a URL of each kind.

### nginx

```nginx
# Share-link, invitation and re-link tokens are in the path, the SSO callback's code in the query.
# $uri is the decoded, normalised path, so a percent-encoded URL can't slip past it.
map $uri $not_unreachable_loggable {
    ~^/(s|invitation|relink|api/v1/public/share-links|api/v1/invitations|api/v1/relink)/ 0;
    ~^/api/v1/sso/[^/]+/callback$ 0;
    default 1;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name files.example.com;

    ssl_certificate     /etc/letsencrypt/live/files.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/files.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    # Mozilla's "intermediate" suites: forward secrecy and AEAD only (TLS 1.3 has nothing else).
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384:DHE-RSA-CHACHA20-POLY1305;
    ssl_prefer_server_ciphers off;

    client_max_body_size 64m;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_read_timeout 1h;

    access_log /var/log/nginx/not-unreachable.access.log combined if=$not_unreachable_loggable;

    location / {
        proxy_pass http://127.0.0.1:8480;
        include /etc/nginx/snippets/not-unreachable-proxy.conf;
    }
}
server {
    listen 80;
    listen [::]:80;
    server_name files.example.com;
    return 301 https://$host$request_uri;
}
```

`/etc/nginx/snippets/not-unreachable-proxy.conf`:

```nginx
proxy_http_version 1.1;
proxy_set_header Host              $host;
proxy_set_header X-Forwarded-For   $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
```

`X-Forwarded-For` is **set** to `$remote_addr` (not appended with
`$proxy_add_x_forwarded_for`), so a client cannot prepend a fake address.

The app's own CSP, HSTS and other headers pass through unchanged; the proxy
adds none, so there is one source of truth.

## First admin

1. The install script (`deploy/install.sh`, run as root from the unpacked
   tarball, by the one-line installer or by hand; the steps for the admin are
   in [docs/install.md](../install.md))
   checks the host, installs `cifs-utils`, polkit and, when `/usr/bin/node` is
   missing, Node 24 from NodeSource. It installs the units, the polkit rules
   (the allow-folder one only while `ALLOW_FOLDERS_FROM_UI=true`), the helpers
   and the CLI, creates the service user (`systemd-sysusers`, with a fixed
   UID and GID: 2000 unless chosen otherwise; an existing user keeps its own),
   the folders and the master key, and writes `config.env`. It asks for the
   service user's ID, `PUBLIC_ORIGIN` and the local folders to allow (or takes
   `--uid` or `NU_UID`, `--public-origin`, `--allow-folder` and `--yes`), and
   stops before changing anything if another user or group has the ID. Then
   it unpacks the release, runs `allow-folder` for each folder, enables and
   starts the service and the backup timer, and runs the exposure check and
   the mode audit. While no admin exists, every page redirects to `/setup`,
   which works only with a **setup token**.
2. Last, the script runs `not-unreachable setup-link`, prints its link and
   warns the admin to keep a copy of the master key apart from the backups.
   Once an admin exists, it says so instead of printing a link.
   `setup-link` makes a setup token
   (32 random bytes; only its SHA-256 goes into the database, valid 1 hour,
   single use, replacing any earlier one) and prints the link
   `https://files.example.com/setup#<token>`. It refuses once an admin exists.
   Running it again before then prints a fresh link and records
   `setup-link.issued`. The token is in the fragment, so it never reaches the
   proxy's logs; the setup page posts it in the body.
3. The admin opens the link and picks a username, email, display name and
   password. Setup does not ask for a second factor: the admin's first
   sign-in does. After the password the session waits (up to 5 minutes) while
   the admin scans a QR code with an authenticator app, confirms it with a code
   and saves the 10 recovery codes shown once; only then is the session active.
4. A first-run token is then refused for good. `setup.completed` is audited.

*Rejected:* a default password (would be on the Internet until changed); an
admin created by CLI with a password typed on the command line (lands in shell
history); "the first person to open the site becomes admin" (a race the Internet
can win).

`sudo not-unreachable reset-admin` is the recovery path for a lost admin
password (threat model, T10). It asks to type the admin's username (or take
`--yes`, and refuses without a terminal otherwise), deletes the password,
revokes every admin session and records `admin.reset` (with the sign-in
methods removed). The options are `--password` (the default when neither is
given), which deletes the password and prints a one-time
`https://files.example.com/setup#<token>` link, where `/setup` sets a new
password for the existing admin, and `--second-factors`, which deletes the
authenticator apps and recovery codes (each recorded as `second-factor.removed`
by `system`, reason `reset-admin`). They can be combined. The next sign-in
forces enrolment again.

## Backups

- **What:** the database and the master key. Files in resources are the admin's
  own data and backed up by the admin's own means.
- **How:** `not-unreachable backup` runs `VACUUM INTO` to
  `/var/lib/not-unreachable/backups/not-unreachable-<UTC timestamp>.sqlite`
  (consistent while the service runs) and keeps the last 7.
  `not-unreachable-backup.timer` (`OnCalendar=daily`, `Persistent=true` so a
  run missed while the host was off happens at the next boot, up to an hour of
  random delay) starts `not-unreachable-backup.service`, which runs it as the
  service user (see [systemd unit](#systemd-unit)). The install enables and
  starts the timer. Pre-migration backups
  (`pre-migration-<UTC timestamp>.sqlite`) don't count towards the 7: each is
  kept until the next successful migration.
- **The master key is not in these backups.** The install script tells the
  admin to store a copy of `/etc/not-unreachable/credentials/master.key` apart
  from the database backups. Without it, encrypted secrets (SMB passwords,
  TOTP secrets, SSO and SMTP secrets) can't be recovered and must be entered
  again; passwords, passkeys and recovery codes still work. The admin signs
  in with a recovery code and adds the authenticator app again, or runs
  `reset-admin --second-factors` to enrol from scratch.
- **Restore:** stop the service, copy the backup to `db/not-unreachable.sqlite`
  (owner `not-unreachable`, `0600`), remove any `-wal` and `-shm` file, start
  the service; migrations bring it forward. The commands are in
  [docs/install.md](../install.md#backups-and-restore).

## Upgrades

Running `install.sh` from a newer release tarball upgrades. It unpacks the new
release to `/opt/not-unreachable/<version>` beside the old one, with the
release's own installer in its `installer/` folder, switches `current` to it
atomically, and restarts the service. Migrations run at start, after a
pre-migration backup. Config, the master key and data are never overwritten,
so an upgrade never turns `ALLOW_FOLDERS_FROM_UI` or `UPDATE_FROM_UI` on; a
config from before a switch existed has it off. The release before is kept for
a rollback; older ones are removed. Running the same tarball again keeps the
releases, config and data as they are, the one kept for a rollback too.

`install.sh` owns its system files by name: the units
`/etc/systemd/system/not-unreachable*.service` and `*.timer` (not the
`not-unreachable.service.d/` drop-ins), the polkit rules
`/etc/polkit-1/rules.d/5?-not-unreachable*.rules`, everything in
`/usr/lib/not-unreachable/`, the CLI, and the sysusers and tmpfiles files.
Each run installs the ones its release ships and removes the owned ones it
doesn't ship, so the system files always match one release exactly, whichever
way it goes: an upgrade, a rollback or an older tarball installed by hand.

Rolling back means stopping the service, restoring the pre-migration backup if
the upgrade migrated the database, running the previous release's kept
installer (`/opt/not-unreachable/<previous>/installer/install.sh --yes`, which
puts its system files back and switches `current` to it), and starting the
service. When the new release fails to start, the installer prints these
commands. The steps are in
[docs/install.md](../install.md#upgrade-and-rollback).

There are three ways to upgrade, all verifying the release's signature with
a pinned key (see [Release signing](#release-signing)): the one-line installer
run again over SSH, the tarball by hand, or **Settings → Updates** while
`UPDATE_FROM_UI` is on (below).

`install.sh --uninstall` stops and removes the units, the polkit rules, the CLI,
the helpers, `/opt/not-unreachable` and `/var/lib/not-unreachable-update`, and
keeps `/etc/not-unreachable`, `/var/lib/not-unreachable`, the `resources.conf`
drop-in and the service user, so a later install picks up where it left off.
`--uninstall --purge` asks the admin to type `delete everything`, then removes
those too.

### Release signing

Each GitHub Release carries `SHA256SUMS` and `SHA256SUMS.sig`, an Ed25519
signature over `SHA256SUMS`'s exact bytes. Each installed release pins the
public keys it trusts, so whoever can change a GitHub Release but doesn't hold
a signing key can't get a release installed. *Decision:* plain Ed25519
checked with Node's `crypto` (the helper and the server) and `openssl` (the
one-line installer, before Node may be installed). *Rejected:* Sigstore, which
would add tools and network access to a root path; minisign, one more binary on
every host for the same primitive; checksums alone, which prove nothing
against a tampered Release.

- **What is signed.** `SHA256SUMS` lists every tarball and the one-line
  installer (`install.sh`), one line each, `<64 lower-case hex>  <file name>`.
  The SBOMs stay out, as before (the copy inside a verified tarball is the one
  to trust). Since the file names hold the version, the signature also covers
  which version each tarball claims to be.
- **The signature file.** `SHA256SUMS.sig` is UTF-8 text, at most 4 KiB, one
  line per signing key, 1 to 4 lines:

  ```
  ed25519 <key id> <signature, standard base64 of 64 bytes>
  ```

  The key id is the first 16 hex digits of the SHA-256 of the key's raw
  32 bytes. A verifier skips lines whose key id it doesn't trust, and accepts
  the file only when at least one trusted line verifies and none fails. Any
  other line format refuses the whole file.
- **The pinned keys.** `deploy/keys/release-signing/<key id>.pem` (SPKI PEM)
  in the repository. `assemble-bundle.sh` copies them to
  `release/release-signing-keys/`, so each release trusts the keys its own
  bundle pins, under `/opt/not-unreachable/<version>/`. The update helper and
  the server read them from the release `current` points to; the one-line
  installer carries them inline, and a test checks they are the repository's
  files. A test also checks each file name is its key's id, and that the
  folder holds 1 to 4 keys.
- **Signing in the Release workflow.** A new job, `sign`, runs after `build`
  and before `publish`, in the GitHub environment `release-signing`. It
  downloads the tarballs, writes `SHA256SUMS`, signs it with
  `scripts/release/sign-checksums.ts` (Node's `crypto.sign`, the private key
  read from the environment variable, never written to disk), verifies the
  result against the pinned public keys, and hands both files to `publish`
  as an artifact. The job has `contents: read` only and references its
  Actions by commit SHA, as the one job that holds a private key; `publish`
  (with `contents: write`) never sees one. Dry runs skip `sign` and
  `publish`. `publish` checks the tarball lines of `SHA256SUMS` against the
  tarballs it attaches before uploading.
- **Where the keys are kept.** Two key pairs are always pinned:
  - the *active* key, which signs every release. Its private key is the
    secret `RELEASE_SIGNING_KEY` (PKCS#8 PEM) of the `release-signing`
    environment, which allows the `main` branch only and needs the
    maintainer's approval for each run, so neither another branch nor an
    unapproved run can read it;
  - the *backup* key, which signs nothing in normal times. Its private key is
    never on GitHub: it is kept offline by the maintainer (an encrypted copy
    in a password manager and one on removable media), for when the active
    key is lost or leaked.
- **Rotating a key on purpose.** A release signed with the active key pins the
  new set (the new active key and the backup); from the next release on, the
  new active key signs. A host still on a release older than the rotation
  trusts only the old keys, so for 12 months after a rotation each release is
  signed with both the old and the new active key (two lines, both private
  keys in the environment: `RELEASE_SIGNING_KEY` and
  `RELEASE_SIGNING_KEY_PREVIOUS`). After that, the old one goes; a host that
  is still older updates once over SSH, checking by hand.
- **A lost active key.** The backup becomes the active key: the maintainer
  signs the next release with it, a release pinning the backup and a new
  backup key. Every installed release already trusts the backup, so no host
  is stranded. Then the new backup's private key is stored offline.
- **A leaked active key.** As for a lost one, at once: the next release is
  signed with the backup key alone and pins the backup and a new backup, not
  the leaked key; a GitHub security advisory tells admins to update. Until a
  host installs it, it still trusts the leaked key, but the key alone isn't
  enough: the attacker must also put files at this repository's GitHub
  Release URLs, which are the only place the helper and installer download
  from (threat model, T17).
- **A leaked or lost backup key.** A normal release signed with the active key
  pins a new backup.
- **Both keys lost.** No new release can reach a host through Settings or the
  one-line installer's check. The maintainer publishes a new key set in a
  release, and every admin installs it once by hand, checking the key ids
  against the repository's `deploy/keys/release-signing/` and
  [docs/install.md](../install.md) (residual risk RR-8).
- **Releases from before signing** have no `SHA256SUMS.sig`. The one-line
  installer refuses them (`--version` of an older release then fails with a
  message to install it by hand), and Settings never offers them. The first
  signed release is installed over SSH, since the release before it has no
  update helper.
- **The one-line installer** (`scripts/release/bootstrap-install.sh`) needs
  `openssl` 3.0 or later (every supported distribution has it). It downloads
  `SHA256SUMS` and `SHA256SUMS.sig` of the version, verifies the signature
  with each trusted line's inline key (`openssl pkeyutl -verify -pubin -rawin
  -in SHA256SUMS -sigfile <decoded signature>`) before reading `SHA256SUMS`
  at all, then checks the tarball as before. It stops on a missing, malformed
  or failing signature and installs nothing. It can't vouch for itself: a
  tampered `install.sh` on a Release is caught only by checking it by hand
  against the signed `SHA256SUMS` (docs/install.md says how).

### Updating from Settings

Opt-in, off by default (`UPDATE_FROM_UI=false`). While it is off, the admin
still sees in **Settings → Updates** whether a newer release is out (unless
`UPDATE_CHECK=false`), with the commands to install it over SSH; nothing that
installs is reachable: the install route is not registered (404), no polkit
rule lets the service user start the update helper, and the helper refuses
anyway.

- **The switch.** `sudo not-unreachable update-from-ui on|off` works exactly
  as `allow-folders-from-ui`: it rewrites `UPDATE_FROM_UI=` in `config.env`
  (temporary file, rename, same owner and mode), installs or removes
  `/etc/polkit-1/rules.d/52-not-unreachable-update.rules` from the copy in
  `/usr/lib/not-unreachable/` (off removes it first), restarts polkit and runs
  `systemctl try-restart not-unreachable.service`. Every install and upgrade,
  the ones from Settings too, syncs the rule with the switch.
- **The rule** lets the service user `start` exactly
  `not-unreachable-update.service`: no other unit, verb or action. Nothing
  lets the service user start the apply unit.
- **The check for new releases** (in the server, `UPDATE_CHECK=true`):
  `GET https://api.github.com/repos/przemczan/not-unreachable/releases/latest`
  with the fixed headers `Accept: application/vnd.github+json`,
  `X-GitHub-Api-Version: 2022-11-28` and `User-Agent: not-unreachable`. No
  version, instance id, origin, cookie or token, and no query string: GitHub
  sees the host's address and the time, as for any download. Redirects are
  not followed; 10 s timeout; the body is capped at 1 MiB and validated
  (`tag_name` `v<version>`, `html_url` under
  `https://github.com/przemczan/not-unreachable/releases/`, `published_at`,
  the asset names). The answer is kept in the database, so a restart doesn't
  ask again. The server asks 1 to 5 minutes after it starts when the kept
  answer is older than 6 hours, then every 6 hours (± 30 minutes), and when
  the admin selects **Check now** (once a minute at most, 10 times an hour
  for the instance). A failed check keeps the last good answer and shows when
  it failed. The latest release is *installable* when it is newer than the
  running version and lists the tarball for this architecture,
  `SHA256SUMS` and `SHA256SUMS.sig`.
- **The download** (the server, after the admin's request passed): from
  `https://github.com/przemczan/not-unreachable/releases/download/v<version>/`,
  never from a URL in the API's answer; https only, redirects only to
  `github.com`, `objects.githubusercontent.com` and
  `release-assets.githubusercontent.com`, at most 5. Into
  `/var/lib/not-unreachable/updates/`, each file written beside its name and
  renamed once complete: the tarball for `process.arch` (at most 256 MiB),
  `SHA256SUMS` (at most 16 KiB) and `SHA256SUMS.sig` (at most 4 KiB). The
  server then checks the signature and checksum itself, with the same module
  as the helper, only to fail early with a clear reason; the helper trusts
  none of it. Then it writes the request and starts the verify unit.
- **The request.** `/run/not-unreachable/update-requests/update.json`
  (service user, `0600`, under 4 KiB): `{"requestId": "<UUID>", "version":
  "<version>"}` and nothing else. The helper reads it as the folder helper
  reads its own (`O_NOFOLLOW` through the pinned directory, checks on the
  descriptor, strict JSON). It never takes a path, a URL or an architecture
  from the server: it derives the spool file names from the version and its
  own architecture, and the spool folder from `DATA_DIR` in root's
  `config.env`.
- **Two units, so hostile input never meets broad rights.** *Decision:* the
  work is split between a verify unit, which handles everything the server
  could have shaped and has almost no rights, and an apply unit, which has
  the rights an upgrade needs but reads only root's own files, already
  verified. *Rejected:* one unit that both parses the spool and writes system
  files, which would run the archive reader with root's install rights; and
  switching `current` alone, which would leave the units, helpers and polkit
  rules of the old release beside a new app.
  - `not-unreachable-update.service` (verify; `Type=oneshot`, no `[Install]`)
    runs `/usr/bin/node /usr/lib/not-unreachable/update-helper.mjs verify` as
    root with `CapabilityBoundingSet=CAP_DAC_READ_SEARCH` only (to read the
    service user's spool), `PrivateNetwork=`, `IPAddressDeny=any`,
    `RestrictAddressFamilies=AF_UNIX`, `ProtectSystem=strict` with
    `StateDirectory=not-unreachable-update` (`StateDirectoryMode=0755`) its
    only writable path, and the rest of the folder helper's sandbox. The
    install fails if its exposure is above 1.5.
  - `not-unreachable-update-apply.service` (apply; `Type=oneshot`, no
    `[Install]`, `TimeoutStartSec=1h`, past the helper's own limits added up
    for a rollback) runs `update-helper.mjs apply` as
    root. It has no polkit rule: only root starts it (the verify unit, or
    `update-recover`). It writes what an upgrade writes and nothing else:
    `ProtectSystem=strict` with `ReadWritePaths=` on `/opt/not-unreachable`,
    `/usr/lib/not-unreachable`, `/usr/local/bin`, `/etc/systemd/system`,
    `/etc/polkit-1/rules.d`, `/usr/lib/sysusers.d`, `/usr/lib/tmpfiles.d`,
    `/srv/not-unreachable`, `/run/not-unreachable-mount` and
    `/var/lib/not-unreachable` (to restore the database), plus its state
    folder; `ProtectHome=read-only`, `PrivateTmp=`, `IPAddressDeny=any` with
    `IPAddressAllow=localhost` (the health check only),
    `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`, and the capabilities
    an install uses (`CAP_CHOWN CAP_FOWNER CAP_DAC_OVERRIDE
    CAP_DAC_READ_SEARCH`). The install fails if its exposure is above 3.0.
- **What the verify unit does**, in order; each refusal is an exit code
  ([below](#the-update-contracts)). Once it has a valid request and knows
  both versions, a refusal also writes the status file with that reason; the
  earlier ones (exits 3 to 9) write none, since the schema needs those fields
  and `busy` or `interrupted` must not overwrite the status of the update they
  are about, so the server records them from the exit code:
  1. **The lock.** It creates `work/lock` with `O_EXCL` (the request id and
     the time). While the apply unit is active or activating, it refuses
     (`busy`). If the status says `installing`, `restarting` or
     `rolling-back`, an update stopped half-way and it refuses
     (`interrupted`), lock or not, until root runs `update-recover`.
     Otherwise (no status, `verifying`, `verified` or `finished`) nothing on
     the host had changed, so it clears an old lock and work and goes on.
     systemd never runs one unit twice at once, so the lock only has to cover
     the two units.
  2. **The switch.** It reads `config.env` itself (root's regular file, not
     writable by group or others) and refuses unless `UPDATE_FROM_UI=true`.
  3. **Private copies.** It reads the request, then opens each spool file
     through the spool folder it opened once (`O_NOFOLLOW` at each step),
     checks on the descriptor that it is a regular file of the service user
     under its size cap, and copies it into `work/<request id>/` while
     counting bytes (a file that grows past its cap is refused). From here on
     it reads only its copies, so the server can't swap a file after a check.
     It checks there is room first: free space of three times the tarball in
     `/opt` and in its state folder (`no-space` otherwise).
  4. **Signature, checksum, version.** The signature of `SHA256SUMS` with the
     keys pinned by the release `current` points to (`unsigned`,
     `signature-invalid`); then the tarball's SHA-256 against the one line of
     `SHA256SUMS` naming `not-unreachable-<requested version>-linux-<own
     arch>.tar.gz` (`checksum-mismatch`); then that the tarball's own
     `VERSION` and `ARCH` equal that version and architecture
     (`version-mismatch`), and that the version is newer than `current` by
     SemVer 2.0 precedence: an older or the same version is refused
     (`not-newer`), so neither a downgrade nor a replay of a signed release
     gets in. It also refuses when `current` has no `installer/` folder
     (`needs-installer`), as nothing could roll it back.
  5. **The archive.** The helper reads the tar itself (`release-archive.mjs`:
     gzip, then ustar and pax headers only, so `build-tarball.sh` writes
     `--format=pax`; no `tar` binary). A first pass
     checks every entry and reads `VERSION` and `ARCH`; a second unpacks. It
     refuses (`archive-unsafe`) an entry outside the one top folder
     `not-unreachable-<version>-linux-<arch>/`, an absolute name, a `..` or
     empty component, a NUL, a hard link, a device, a FIFO or a socket, a
     setuid, setgid or sticky bit, a duplicate name, and a symlink unless it
     lies under `release/node_modules/` with a relative target (`../`
     steps, then plain names) that stays inside `release/` once resolved by
     name; GNU long-name entries, global pax headers and sparse files; and an archive over 1 GiB
     unpacked or 200 000 entries. A corrupt or truncated archive is
     `archive-invalid`. It unpacks into `work/<request id>/staged/` with
     `O_EXCL` and `O_NOFOLLOW`, root as owner, modes `0755` and `0644`
     (`0755` for files the archive marks executable).
  6. **Hand-over.** It writes `work/staged.json` (request id, from, to, the
     staged folder) and the status `verified`, starts the apply unit with
     `systemctl start --no-block not-unreachable-update-apply.service`
     (`systemd-failed` otherwise), and exits 0. Its exit tells the server the
     release passed; the server stops the request there and from now on reads
     the status file.
- **What the apply unit does.** It reads `work/staged.json` and the status
  (root's files in a root-only folder) and brings the host to a finished
  state:
  1. If the status is `verified`, it checks `UPDATE_FROM_UI=true` again
     (`refused`, `switch-off` otherwise, with nothing changed), notes which
     pre-migration backups exist, sets `installing` and runs the
     staged release's installer, `bash install.sh --apply-update`, with a
     10-minute limit.
     `--apply-update` is `--yes` without the parts an offline, non-interactive
     upgrade can't do: it first checks the host as any install does, and that
     the service user exists and `/usr/bin/node` suits the release, and exits
     3 (`needs-installer`) before changing anything when they don't (a new
     Node major, a new package); it never installs packages, asks nothing,
     doesn't start the service and prints no setup link. Then it does what an
     upgrade does: the system files (removing owned ones it doesn't ship),
     the rules synced with both switches, the release and its `installer/`
     into `/opt/not-unreachable/<version>`, `current` switched, older
     releases pruned (keeping the one it replaced), `systemctl daemon-reload`,
     polkit restarted, the exposure checks and the mode audit.
  2. It sets `restarting` and runs `systemctl restart not-unreachable.service`
     (5-minute limit). With `Type=notify`, that returns only once the new
     server has migrated and listens. **Healthy** then means: for 30 seconds
     the unit stays `active` with the same `MainPID` and an unchanged
     `NRestarts`, and `GET /api/v1/health` with `X-Forwarded-Proto: https`
     on the loopback address of `LISTEN_PORT` answers 200. When `LISTEN_HOST`
     is neither loopback nor a wildcard, or `TRUSTED_PROXIES` holds no
     loopback address, the helper can't ask (its unit reaches loopback only),
     logs so, and readiness and the 30 seconds decide alone.
  3. Healthy: the status `finished`, `succeeded`; it deletes `work/` but the
     lock, then the lock. The installer has already pruned older releases,
     so the one before stays for a rollback by hand.
  4. Not healthy, or the installer failed (any exit but 0 and 3): it sets
     `rolling-back`, stops the service, and restores the database when the
     new release made a pre-migration backup: the oldest one not there before,
     as a release that crash-loops makes one at each start, of a database
     already migrated. `db/` and `backups/` are opened once without following
     a symlink and checked as the service user's. It is copied beside
     `db/not-unreachable.sqlite`, given to the service user with mode `0600`,
     `fsync`ed and renamed over it, `-wal` and `-shm` removed. The old code
     can't be trusted on a migrated schema, so this comes before anything
     starts. Then it runs the previous release's kept installer, `bash
     /opt/not-unreachable/<from>/installer/install.sh --apply-update`, which
     puts that release's system files back and switches `current` back, and
     restarts the service with the same health check. The result is
     `rolled-back` with the reason (`installer-failed`, `start-failed` or
     `unhealthy`), or `rollback-failed` when the old release doesn't come
     back either: then the service stays down and the admin follows
     [docs/install.md](../install.md#upgrade-and-rollback) over SSH.
  5. If the status is `installing`, `restarting` or `rolling-back`, the host
     was left half-way (a power cut, a killed unit): this is `update-recover`.
     It rolls back as in 4, from wherever it stopped, and finishes with
     `interrupted` (or `rollback-failed`). Every step of 4 is safe to run
     again.
- **`sudo not-unreachable update-recover`** starts the apply unit and waits
  for it, whatever the switch. It is what Settings and the helper's
  `interrupted` refusal tell the admin to run. A normal install or upgrade
  over SSH also ends an interrupted update: it removes the lock and the work
  folder, and sets the status to `interrupted` if it was still in progress.
  While it runs it holds updates from Settings: a runtime drop-in
  (`/run/systemd/system/<unit>.d/50-install-running.conf`,
  `RefuseManualStart=yes`) on both update units, removed when it exits however
  it exits. It refuses to run while either unit is running.
- **The server.** Beside `POST /api/v1/admin/resources/allowed-folders` and
  under the same rules ([the contracts](#the-update-contracts) below): admin
  only; the password and an authenticator code or passkey answer in every
  install request, checked as at sign-in under the same try limits (threat
  model, T10, T11); 5 install requests per account per 15 minutes; one update
  at a time (409 otherwise, also while the status file says one is in
  progress). It records `update.requested` for every install request and
  `update.finished` once per accepted one. The finish is recorded by
  whichever server sees the final status first: the new release after a
  success, the old one after a rollback, or the server itself when the verify
  unit refuses. A `succeeded` emails the admin a security notice, and a
  `rolled-back` or `rollback-failed` an alert (T10). Problem bodies and logs
  hold versions and reasons only.
- **The admin interface.** **Settings → Updates** shows the running version,
  the latest release with a link to its notes, when the server last checked,
  **Check now**, and the last update's result. With `UPDATE_FROM_UI` on, an
  installable release gets **Install**: the password and a second factor,
  then each step as it happens (downloading, verifying, installing,
  restarting), a wait for `/api/v1/health` once the service goes away, then
  the result from the status file. Off, it shows the `update-from-ui on`
  command and the one-line installer instead. The screens and wording are in
  the design attached to the Task.

#### The update contracts

**The status file**, `/var/lib/not-unreachable-update/status.json`, written by
the helper only (temporary file, `fsync`, rename; `0644`), read by the server
with a strict zod schema (a file that doesn't parse is shown as unknown, never
trusted):

```json
{
  "schema": 1,
  "requestId": "6f1c…",
  "from": "1.4.0",
  "to": "1.5.0",
  "phase": "finished",
  "result": "rolled-back",
  "reason": "unhealthy",
  "signingKey": "3fa9c01e7b2d4c55",
  "startedAt": "2026-11-25T14:02:11.000Z",
  "updatedAt": "2026-11-25T14:03:40.000Z",
  "finishedAt": "2026-11-25T14:03:40.000Z"
}
```

| Field | Values |
|---|---|
| `phase` | `verifying`, `verified`, `installing`, `restarting`, `rolling-back`, `finished` |
| `result` | `null` until `finished`; then `succeeded`, `refused` (the verify unit refused it; nothing changed), `rolled-back`, `rollback-failed` or `interrupted` |
| `reason` | `null` for `succeeded`; otherwise one of the reasons below |
| `signingKey` | The key id that verified the release, or `null` before |

**The reasons** (`updateReasons` in `packages/contracts`, each with its words
in the admin interface), and the verify unit's exit codes, which the server
reads from `ExecMainStatus` as it does the folder helper's:

| Exit | Reason | Meaning |
|---|---|---|
| 0 | – | Verified, staged, the apply unit started. |
| 1 | `internal` | Anything unexpected. |
| 2 | `internal` | Not `verify` or `apply`. |
| 3 | `request-invalid` | No request file. |
| 4 | `request-invalid` | The request is a symlink, not a regular file, not the service user's, not `0600`, 4 KiB or more, or its folder isn't one. |
| 5 | `request-invalid` | Not UTF-8 JSON, missing or unknown keys, a bad request id or version. |
| 6 | `switch-off` | `UPDATE_FROM_UI` is not `true`. |
| 7 | `internal` | `config.env` isn't root's regular file, is writable by group or others, or can't be read. |
| 8 | `busy` | The apply unit is running. |
| 9 | `interrupted` | An earlier update stopped half-way; `update-recover` first. |
| 20 | `download-incomplete` | A spool file is missing. |
| 21 | `download-incomplete` | A spool file is a symlink, not a regular file, not the service user's, or over its cap. |
| 22 | `unsigned` | No `SHA256SUMS.sig`, or no line with a trusted key id. |
| 23 | `signature-invalid` | A trusted line doesn't verify, or the file is malformed. |
| 24 | `checksum-mismatch` | No line for the tarball, a malformed `SHA256SUMS`, or a different SHA-256. |
| 25 | `version-mismatch` | `VERSION` or `ARCH` in the tarball isn't the signed name's. |
| 26 | `not-newer` | The same as or older than `current`. |
| 27 | `archive-unsafe` | An entry breaks the archive rules. |
| 28 | `archive-invalid` | Not a gzip tar, corrupt or truncated. |
| 29 | `needs-installer` | `current` has no kept installer, so this one must be installed over SSH. |
| 30 | `systemd-failed` | The apply unit couldn't be started. |
| 31 | `no-space` | Not enough free disk space. |

The apply unit's reasons go only to the status file: `needs-installer`
(`--apply-update` exited 3; nothing changed, so the result is `refused`),
`installer-failed`, `start-failed` (not ready within 5 minutes) and
`unhealthy`. The server adds its own: `download-failed` (GitHub unreachable,
an HTTP error, a redirect off the list, a timeout) and `download-incomplete`
(over a cap), recorded as `refused` without a status file.

**`install.sh --apply-update`** exits 0 (done), 3 (`needs-installer`: nothing
changed) or 1 (failed, the host may be half-way).

**The routes** (`packages/contracts/src/updates.ts`):

| Route | Access | Answers |
|---|---|---|
| `GET /api/v1/admin/updates` | admin | 200 `UpdatesOverview` (below). |
| `POST /api/v1/admin/updates/check` | admin, `UPDATE_CHECK=true` only (404 otherwise) | 200 `UpdatesOverview` after asking GitHub; 429 past the limits. |
| `POST /api/v1/admin/updates/install` | admin, `UPDATE_FROM_UI=true` only (404 otherwise); `recentSignIn: false`, the proof is in the body | Body `{ version, reauthentication }` (the `reauthenticationSchema` of `allowFolder`). 202 `{ requestId }` once both factors passed and the version is the latest installable one; 401 `sign-in-failed` or `second-factor-failed`; 409 `update-not-available` (not the latest installable release) or `update-in-progress`; 429 past the limits. |

```ts
interface UpdatesOverview {
  current: { version: string };
  check:
    | { enabled: false }
    | {
        enabled: true;
        checkedAt: string | null; // the last answer GitHub gave
        failedAt: string | null; // a later check that failed, if any
        latest: {
          version: string;
          publishedAt: string;
          releaseNotesUrl: string; // the Release's html_url
          installable: boolean;
          notInstallableBecause: "not-newer" | "unsigned" | "no-tarball" | null;
        } | null;
      };
  install: {
    enabled: boolean; // UPDATE_FROM_UI
    switchCommand: "sudo not-unreachable update-from-ui on";
    installerCommand: string; // the one-line installer
  };
  // The update in progress, or the last one; null before the first.
  update: {
    requestId: string;
    from: string;
    to: string;
    phase: "downloading" | "verifying" | "verified" | "installing" | "restarting" | "rolling-back" | "finished";
    result: "succeeded" | "refused" | "rolled-back" | "rollback-failed" | "interrupted" | null;
    reason: UpdateReason | null;
    startedAt: string;
    finishedAt: string | null;
  } | null;
}
```

`downloading` is the server's own phase (kept in memory: a restart during it
ends the update as `refused`, `download-failed`); the rest come from the
status file.

**The audit events** (`packages/contracts/src/audit-events.ts`):

| Event | When | Details |
|---|---|---|
| `update.requested` | Every install request whose body is valid | `requestId`, `from`, `to`, `outcome`: `accepted`, `denied` (a failed proof, which also records `sign-in.failed` or `second-factor.failed`), `refused` (409) or `error` (anything unexpected, such as the server too busy to check the password). |
| `update.finished` | Once per accepted request, when a server sees it finished | `requestId`, `from`, `to`, `result`, `reason`, `signingKey`. Actor: the admin who asked. |

**Mail.** `update-succeeded` (a security notice: "NotUnreachable was updated
to 1.5.0 from Settings", the time, and what to do if it wasn't the admin) and
`update-rolled-back` (the version, the reason, and that the server is back on
the old release with its data as before). Both go to the admin, after SMTP is
set (RR-3). A `rollback-failed` leaves no server to send mail; the server that
comes back after the admin's repair records it and sends the alert then.
