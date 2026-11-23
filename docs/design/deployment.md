# Deployment

The target is one Linux host with systemd ≥ 252 (Debian 12+, Ubuntu 24.04+,
Fedora 40+, RHEL 9+), x86-64 or arm64. The app runs as one process behind a
TLS reverse proxy. The **Install** Task (Task 1e20d309-2836-46ce-be58-757b7307d1f2)
turns this file into the install script; the **Skeleton** Task (Task
94776ed7-0244-4ba0-bd52-a6cfbac33271) implements config loading as specified here.

## Config, secrets and data

| Path | Owner / mode | Holds |
|---|---|---|
| `/opt/not-unreachable/<version>/` | `root:root 0755`, read-only | The release (server, web build, migrations, production `node_modules`). |
| `/opt/not-unreachable/current` | symlink | The release in use. |
| `/usr/local/bin/not-unreachable` | `root 0755` | The CLI wrapper (`migrate`, `setup-link`, `reset-admin`, `rotate-key`, `backup`, `allow-folder`); it runs as the service user unless the subcommand needs root. |
| `/usr/lib/not-unreachable/mount-helper.mjs` | `root 0644` | The SMB mount helper, run by `/usr/bin/node` (see [smb.md](smb.md)). |
| `/etc/not-unreachable/config.env` | `root:not-unreachable 0640` | Bootstrap config (below). |
| `/etc/not-unreachable/credentials/master.key` | `root:root 0600` | 32 random bytes, made at install. Given to the service by `LoadCredential=`. |
| `/var/lib/not-unreachable/` | `not-unreachable 0700` (`StateDirectory`) | Data: |
| `  db/not-unreachable.sqlite` (+ `-wal`, `-shm`) | `0600` | The database. |
| `  uploads/` | `0700` | tus staging. |
| `  backups/` | `0700` | Pre-migration and scheduled backups. |
| `/srv/not-unreachable/mounts/` | `root:root 0755` | SMB mount points, `<resourceId>/` each, made by the helper. Root-owned, so the helper never acts inside a directory the service controls. Inside a mount, everything belongs to the service user (`forceuid`, `dir_mode=0750`). |
| `/run/not-unreachable/` | `not-unreachable 0700` (`RuntimeDirectory`) | Mount request files (short-lived). |
| `/run/not-unreachable-mount/` | `root 0700` | The helper's short-lived credentials files. |
| journald | | Logs (`journalctl -u not-unreachable`). |

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

## systemd unit

`/etc/systemd/system/not-unreachable.service`:

```ini
[Unit]
Description=NotUnreachable file sharing
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=notify
NotifyAccess=main
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

- `Type=notify`: the server calls `sd_notify("READY=1")` (through the
  `NOTIFY_SOCKET` datagram, no native module) only after migrations ran and it
  listens, so `systemctl start` reports a failed migration.
- **Local folders**: `ProtectSystem=strict` makes the whole file system
  read-only for the service. A local folder the admin maps must be listed in
  `ReadWritePaths=` (or `ReadOnlyPaths=`) through a drop-in,
  `/etc/systemd/system/not-unreachable.service.d/resources.conf`. The install
  script asks for these folders, and `not-unreachable allow-folder <path>`
  (root) adds one later and restarts the service. The **Add resource → Local
  folder** screen checks that the path is writable and, if not, shows the
  exact command to run. *Rejected:* letting the service write anywhere
  (`ProtectSystem=full`), which throws away most of the hardening for one
  convenience.
- `ProtectHome=yes` hides `/home`, `/root` and `/run/user`. Mapping a folder
  under `/home` needs `ProtectHome=tmpfs` plus `BindPaths=`; the drop-in tool
  handles that case.
- The install script runs `systemd-analyze security not-unreachable` and fails
  if the exposure score is above 2.0.
- `WorkingDirectory` is the release root that `pnpm deploy` writes (see
  [stack.md](stack.md#release-artefact)), so the entry point is `dist/main.js`.
- The mount helper's unit, `not-unreachable-mount@.service`, runs as root and
  must stay in the host's mount namespace, so it can't use `ProtectSystem=`,
  `ProtectHome=`, `PrivateTmp=` or any other directive that would give it a
  namespace of its own; a mount made there would never reach the host. Its
  hardening without one is listed in [smb.md](smb.md#what-happens-underneath).

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
	log {
		output file /var/log/caddy/not-unreachable.log
		# Keep share-link tokens out of the access log.
		format filter {
			wrap json
			fields {
				request>uri regexp ^/(s|api/v1/public/share-links)/[^/?]+ /$1/REDACTED
			}
		}
	}
}
```

Caddy sends `X-Forwarded-For` and `X-Forwarded-Proto` by default.

### nginx

```nginx
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name files.example.com;

    ssl_certificate     /etc/letsencrypt/live/files.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/files.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    client_max_body_size 64m;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_read_timeout 1h;

    # Keep share-link tokens out of the access log.
    location /s/ {
        access_log off;
        proxy_pass http://127.0.0.1:8480;
        include /etc/nginx/snippets/not-unreachable-proxy.conf;
    }
    location /api/v1/public/share-links/ {
        access_log off;
        proxy_pass http://127.0.0.1:8480;
        include /etc/nginx/snippets/not-unreachable-proxy.conf;
    }
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

1. The install script creates the service user, the folders and the master key,
   writes `config.env` (it asks for `PUBLIC_ORIGIN`), installs and starts the
   service. While no admin exists, the server serves only the setup page and
   its API, and both need a **setup token**.
2. The script runs `not-unreachable setup-link`, which makes a setup token
   (32 random bytes; only its hash goes into the database, valid 1 hour,
   replacing any earlier one) and prints the link
   `https://files.example.com/setup#<token>`. Running it again prints a fresh
   link. The token is in the fragment, so it never reaches the proxy's logs;
   the setup page posts it in the body.
3. The admin opens the link and picks a username, email and password, then
   **must** add a second factor (authenticator app or passkey; email codes are
   not available before SMTP is set up) and save the recovery codes. Until the
   2FA Task has landed, setup ends after the password, and that Task makes the
   admin enrol at the next sign-in (see the [task map](README.md#task-map)).
4. The setup route then answers 404 for good. `setup.completed` is audited.

*Rejected:* a default password (would be on the Internet until changed); an
admin created by CLI with a password typed on the command line (lands in shell
history); "the first person to open the site becomes admin" (a race the Internet
can win).

`sudo not-unreachable reset-admin` is the recovery path for a lost admin account
(threat model, T10).

## Backups

- **What:** the database and the master key. Files in resources are the admin's
  own data and backed up by the admin's own means.
- **How:** `not-unreachable backup` runs `VACUUM INTO` to
  `/var/lib/not-unreachable/backups/not-unreachable-<UTC timestamp>.sqlite`
  (consistent while the service runs) and keeps the last 7. A systemd timer
  (`not-unreachable-backup.timer`, daily) runs it. Pre-migration backups are
  kept until the next successful migration.
- **The master key is not in these backups.** The install script tells the
  admin to store a copy of `/etc/not-unreachable/credentials/master.key` apart
  from the database backups. Without it, encrypted secrets (SMB passwords,
  TOTP secrets, SSO and SMTP secrets) can't be recovered and must be entered
  again; passwords and passkeys still work.
- **Restore:** stop the service, copy the backup to `db/not-unreachable.sqlite`
  (owner `not-unreachable`, `0600`), start the service; migrations bring it
  forward.

## Upgrades

Out of scope here (self-update is a later Initiative). By hand: unpack the new
release next to the old one, switch `current`, restart. Migrations run at start,
after a backup. Rolling back means switching `current` back and restoring the
pre-migration backup.
