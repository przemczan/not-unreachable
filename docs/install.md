# Installing NotUnreachable

NotUnreachable runs on one Linux server as a hardened systemd service, behind a
TLS reverse proxy (Caddy or nginx) that you run. The installer sets up
everything else: Node 24, the packages SMB shares need, a dedicated service
user, the folders, the master key, the config, the systemd units and a daily
backup. The design behind it is in
[docs/design/deployment.md](design/deployment.md).

## What you need

- **Linux:** Debian 12 or newer, Ubuntu 24.04 or newer, Fedora 40 or newer, or
  RHEL, AlmaLinux or Rocky Linux 9 or newer, on x86-64 or arm64, with systemd
  252 or newer and glibc (not musl: Alpine isn't supported).
- **Node:** none, or Node 24.11 or newer at `/usr/bin/node`. The installer
  installs Node 24 from NodeSource when there is none, and refuses to replace
  another major version.
- **Root**, through `sudo`.
- **A domain name** pointing at the server, such as `files.example.com`, and
  ports 80 and 443 open for the reverse proxy.

## Install

```sh
curl -fsSL https://github.com/przemczan/not-unreachable/releases/latest/download/install.sh | sudo bash
```

This downloads the latest release's `SHA256SUMS` and its signature,
`SHA256SUMS.sig`, from
[GitHub Releases](https://github.com/przemczan/not-unreachable/releases), and
stops unless the signature verifies with one of the
[release signing keys](#release-signing-keys) the script carries. Then it
downloads the tarball for your architecture, stops if its checksum doesn't
match the signed `SHA256SUMS`, unpacks it into a temporary folder and runs the
tarball's own `install.sh`. It needs `openssl` 3.0 or later, which every
supported distribution has. To read the script before you run it, download it
first, [check it](#check-the-one-line-installer) and run it with
`sudo bash install.sh`.

It asks for:

- **The public origin:** the `https://` address people open, such as
  `https://files.example.com`, with no path. It must be https.
- **The local folders to allow:** the folders on this server the admin may
  share, such as `/srv/media`. The service can't write anywhere else. Leave it
  empty to add none; add one later with `sudo not-unreachable allow-folder
<path>`.
- **The service user's UID and GID:** one number for both, 2000 if you just
  press Enter. See [The service user's ID](#the-service-users-id).

To install without questions, give them as options after `bash -s --`:

```sh
curl -fsSL https://github.com/przemczan/not-unreachable/releases/latest/download/install.sh |
  sudo bash -s -- --public-origin https://files.example.com --allow-folder /srv/media --uid 2000 --yes
```

`--allow-folder` can be given more than once. With `--yes` and no `--uid`, the
service user gets 2000. `--version 1.2.3` installs that release instead of the
latest; a release from before releases were signed has no `SHA256SUMS.sig`, so
the script refuses it: install that one [by hand](#download-and-verify-by-hand).
`--help` lists the script's own options; every other option goes to
the tarball's `install.sh`, whose `--help` lists them all.

### Download and verify by hand

Instead of the command above, you can do its steps yourself. Each release has
a tarball for each architecture, `SHA256SUMS` (the SHA-256 of each tarball and
of the one-line installer, `install.sh`), its signature `SHA256SUMS.sig`, and
the CycloneDX SBOM of each tarball (also inside it, as `sbom.cdx.json`).

First check the signature of `SHA256SUMS` with the active
[release signing key](#release-signing-keys), then the tarball against
`SHA256SUMS`:

```sh
version=1.0.0   # from the Releases page
arch=x64        # or arm64: uname -m says x86_64 or aarch64
base=https://github.com/przemczan/not-unreachable/releases/download/v$version
curl -fLO "$base/not-unreachable-$version-linux-$arch.tar.gz"
curl -fLO "$base/SHA256SUMS"
curl -fLO "$base/SHA256SUMS.sig"
cat > release-signing-key.pem <<'EOF'
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEASR0hb5IxGr2JVKNNw0xnXvNmrK7XyLgTJmaW12efUAU=
-----END PUBLIC KEY-----
EOF
grep '^ed25519 5215940524b38b8b ' SHA256SUMS.sig | cut -d ' ' -f 3 | base64 -d > SHA256SUMS.sig.bin
openssl pkeyutl -verify -pubin -inkey release-signing-key.pem -rawin -in SHA256SUMS -sigfile SHA256SUMS.sig.bin
sha256sum --check --ignore-missing SHA256SUMS
tar -xzf "not-unreachable-$version-linux-$arch.tar.gz"
cd "not-unreachable-$version-linux-$arch"
sudo ./install.sh
```

Don't go on unless `openssl` says `Signature Verified Successfully` and
`sha256sum` says `OK`. If `SHA256SUMS.sig` has no line for the active key, use
the backup key's id and key from [the table](#release-signing-keys) instead.
The tarball's `install.sh` takes the same options, such as
`sudo ./install.sh --public-origin https://files.example.com --yes`.

#### Check the one-line installer

The one-line installer checks every release it installs, but nothing checks
the installer itself: whoever could change a GitHub Release could change
`install.sh` there too. To be sure of it, download it from the release it
belongs to and check it against that release's signed `SHA256SUMS`, which
lists it, as above:

```sh
curl -fLO "$base/install.sh"
# Then the same openssl command as above, and:
sha256sum --check --ignore-missing SHA256SUMS
sudo bash install.sh
```

`sha256sum` must say `install.sh: OK`. The `latest/download/install.sh` of the
command at the top is the latest release's own.

#### Release signing keys

Every release is signed with the active key; the backup key signs nothing
unless the active one is lost or leaked. Both are pinned in the repository, in
[`deploy/keys/release-signing/`](../deploy/keys/release-signing/), in the
one-line installer and in every installed release
(`/opt/not-unreachable/<version>/release-signing-keys/`):

| Key    | Key id             | Public key (SPKI PEM, between the `BEGIN` and `END PUBLIC KEY` lines) |
| ------ | ------------------ | --------------------------------------------------------------------- |
| Active | `5215940524b38b8b` | `MCowBQYDK2VwAyEASR0hb5IxGr2JVKNNw0xnXvNmrK7XyLgTJmaW12efUAU=`        |
| Backup | `ac8f1017437bcf2e` | `MCowBQYDK2VwAyEAQBKHauils+vfg7vLDb35N9Jl7Bv1a8WSGa6huIhLggA=`        |

A key id is the first 16 hex digits of the SHA-256 of the key's 32 raw bytes;
to check one, run
`openssl pkey -pubin -in release-signing-key.pem -outform DER | tail -c 32 | sha256sum | cut -c 1-16`.
How the keys are kept and replaced is in
[deployment.md, "Release signing"](design/deployment.md#release-signing).

### What it checks

The installer stops with an error, changing nothing more, if the host isn't
supported, the tarball is for another architecture, the service user's UID or
GID is already another user's or group's, or the service fails to start. It
also fails if the service's sandbox scores above 2.0 in
`systemd-analyze security not-unreachable.service` (above 1.5 for the folder
helper's unit and the update helper's verify unit, above 3.0 for its apply
unit), or if a file's owner or mode isn't the one in the design's table.

> **Mapped folders must not be writable by other users of the server.** The
> service checks every path it opens, but another local account that can write
> in a shared folder could swap in files between checks. Keep each allowed
> folder, and everything in it, owned by root or the service user
> (`not-unreachable`), and not writable by group or others.

### What it installs

| Path                                                          | What                                                                                                 |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `/opt/not-unreachable/<version>`                              | The release, with its own installer and the signing keys it trusts; `current` links to the one used  |
| `/usr/local/bin/not-unreachable`                              | The admin CLI (root only)                                                                            |
| `/etc/not-unreachable/config.env`                             | The config                                                                                           |
| `/etc/not-unreachable/credentials/master.key`                 | The master key (root only)                                                                           |
| `/var/lib/not-unreachable/`                                   | The database, uploads and backups                                                                    |
| `/usr/lib/not-unreachable/mount-helper.mjs`                   | The SMB mount helper                                                                                 |
| `/usr/lib/not-unreachable/folder-helper.mjs`                  | The folder helper (with `folder-access.mjs`, `request-file.mjs` and a copy of its polkit rule)       |
| `/usr/lib/not-unreachable/update-helper.mjs`                  | The update helper (with `release-verify.mjs`, `release-archive.mjs` and a copy of its polkit rule)   |
| `/var/lib/not-unreachable-update/`                            | The status of the last update from Settings, and the update helper's work folder                     |
| `/srv/not-unreachable/mounts/`                                | Where SMB shares are mounted                                                                         |
| `/etc/systemd/system/not-unreachable*`                        | The service, the backup timer, the mount units, the folder and update helpers' units                 |
| `/etc/polkit-1/rules.d/50-not-unreachable.rules`              | Lets the service start mount units only                                                              |
| `/etc/polkit-1/rules.d/51-not-unreachable-allow-folder.rules` | Lets the service start the folder helper; only while allowing folders from the admin interface is on |
| `/etc/polkit-1/rules.d/52-not-unreachable-update.rules`       | Lets the service start the update helper; only while updating from Settings is on                    |

The service user `not-unreachable` has no shell and can't sign in. The full
table, with every owner and mode, is in
[deployment.md, "Config, secrets and data"](design/deployment.md#config-secrets-and-data).

### The service user's ID

The service user `not-unreachable` and its group `not-unreachable` get a fixed
UID and GID, the same number: **2000** unless you choose another. Knowing it
before you install lets you map a folder into a container for it, as in
[LXC containers](#lxc-containers). The installer asks for it on a first
install; to answer without the question, pass `--uid <id>` or set `NU_UID`
(`--uid` wins when both are given):

```sh
sudo ./install.sh --uid 2500
sudo NU_UID=2500 ./install.sh
```

The ID must be a number from 1 to 60000; systemd keeps the IDs above for its
own users. If another user already has the UID, or another group the GID, the
installer stops before changing anything: choose another ID. If a group named
`not-unreachable` is left from an earlier install, the service user joins it
with its GID, and the installer says so.

An upgrade asks nothing. A service user that exists already keeps the UID and
GID it has, including one from a release before IDs were fixed (such as 989),
and the installer prints them. If you pass another ID then, it warns and still
keeps the existing one.

#### Changing the service user's ID

The installer never changes the ID of an existing service user. To move it to
another ID by hand (here from 989 to 2000; `getent passwd not-unreachable`
shows the current one), stop the service and change the owner of everything
the old IDs own:

```sh
sudo systemctl stop not-unreachable.service not-unreachable-backup.timer
sudo groupmod -g 2000 not-unreachable
sudo usermod -u 2000 -g 2000 not-unreachable
sudo chown -R -h not-unreachable:not-unreachable /var/lib/not-unreachable
sudo chgrp not-unreachable /etc/not-unreachable/config.env
# What the service made in the allowed folders still has the old IDs.
sudo find /srv/media -xdev \( -uid 989 -o -gid 989 \) -exec chown -h not-unreachable:not-unreachable {} +
sudo sed -i -E 's/^(g not-unreachable) [0-9]+$/\1 2000/; s/^(u not-unreachable) [0-9]+:/\1 2000:/' \
  /usr/lib/sysusers.d/not-unreachable.conf
sudo systemctl start not-unreachable.service not-unreachable-backup.timer
```

Run the `find` over every allowed folder: they are the `ReadWritePaths=` lines
of `/etc/systemd/system/not-unreachable.service.d/resources.conf`. A sysusers
file from a release before IDs were fixed has `-` in place of them, which the
`sed` leaves; the next upgrade writes the user's new IDs into it.

### LXC containers

To use a folder of the host, such as a NAS share mounted on a Proxmox host, in
an unprivileged LXC container, map the service user's ID through to the host
**before** you install, so the files the service writes belong to the same ID
on both sides. Mapping it afterwards leaves the files made before with an owner
the service can't use, and it fails with `Permission denied` on its
`STATE_DIRECTORY`.

1. On the host, let root map the ID: add this line to both `/etc/subuid` and
   `/etc/subgid` (for 2000; use your ID if you choose another):

   ```text
   root:2000:1
   ```

2. In the container's config (`/etc/pve/lxc/<id>.conf` on Proxmox), map the
   container's IDs 0–1999 and 2001–65535 as usual and 2000 to the host's 2000,
   and bind-mount the folder:

   ```text
   lxc.idmap: u 0 100000 2000
   lxc.idmap: g 0 100000 2000
   lxc.idmap: u 2000 2000 1
   lxc.idmap: g 2000 2000 1
   lxc.idmap: u 2001 102001 63535
   lxc.idmap: g 2001 102001 63535
   mp0: /mnt/nas/media,mp=/srv/media
   ```

3. On the host, give the folder to that ID: `chown -R 2000:2000 /mnt/nas/media`
   (or set the NAS share's owner to 2000 when it is mounted, such as with
   `uid=2000,gid=2000` for CIFS).
4. Start the container and install inside it, with `--uid 2000` (or the ID
   you mapped) and `--allow-folder /srv/media`.

## The first admin

The installer ends by printing a one-time setup link:

```
https://files.example.com/setup#<token>
```

1. Set up the reverse proxy first (below), so the link opens.
2. Open the link within an hour, and pick the admin's username, email, display
   name and password.
3. Sign in. You are asked for a second factor before you can go on: scan the QR
   code with an authenticator app and confirm it with a code, then save the 10
   recovery codes somewhere safe. Once signed in, you can add a passkey too, in
   your account's security settings.

If the link expired, print a new one (it replaces the old one):

```sh
sudo not-unreachable setup-link
```

Once an admin exists, no setup link is printed any more. If the admin loses
their password or second factor, `sudo not-unreachable reset-admin` resets it
(see [deployment.md, "First admin"](design/deployment.md#first-admin)).

To let people sign in with Google, GitHub or another OpenID Connect provider,
open **Settings → Sign-in providers → Add provider**: its **How to set this up**
lists the steps at the provider and the redirect URI to register there.

An invitation sent by email, or one marked **Require a verified matching
email**, can only be accepted through a provider that reports the invitee's
email as verified: GitHub (any verified address of the account), or an OpenID
Connect provider whose ID token has `email_verified: true`, as Google's does.
Providers that leave `email_verified` out, such as Microsoft Entra ID, can't
accept these invitations; send those invitees a link without the requirement.

## Reverse proxy

The service listens on `127.0.0.1:8480` only. A reverse proxy on the same
server terminates TLS and forwards to it. Whichever you use, it must:

- **Keep tokens out of its access log.** Share links, invitations and re-link
  links carry their token in the URL path (`/s/`, `/invitation/`, `/relink/`
  and their `/api/v1/…` routes), and the sign-in provider's code comes back in
  the query of `/api/v1/sso/<id>/callback`.
- **Accept request bodies up to 64 MiB.** Uploads come in 64 MiB chunks.
- **Not buffer** requests or responses, so uploads and downloads stream.
- **Set `X-Forwarded-For` and `X-Forwarded-Proto`**, replacing what the client
  sent rather than appending to it.

The app sends its own security headers (CSP, HSTS and the rest); the proxy
should add none.

### Caddy (recommended)

Caddy gets and renews the certificate by itself. Copy
`deploy/proxy/Caddyfile` to `/etc/caddy/Caddyfile` (or import it from yours),
replace `files.example.com` with your host, and reload:

```sh
sudo install -m 0644 deploy/proxy/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/files\.example\.com/your.host.name/' /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

It needs Caddy 2.8 or later. It limits bodies to 64 MiB (`request_body`),
streams (`flush_interval -1`) and leaves the requests that carry a token out of
the access log (`log_skip`).

### nginx

nginx needs a certificate from elsewhere, such as certbot. The example expects
Let's Encrypt's paths.

```sh
sudo install -m 0644 deploy/proxy/nginx-not-unreachable-proxy.conf /etc/nginx/snippets/not-unreachable-proxy.conf
sudo install -m 0644 deploy/proxy/nginx-not-unreachable.conf /etc/nginx/sites-available/not-unreachable
sudo sed -i 's/files\.example\.com/your.host.name/g' /etc/nginx/sites-available/not-unreachable
sudo ln -s ../sites-available/not-unreachable /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

On Fedora and RHEL, put it in `/etc/nginx/conf.d/not-unreachable.conf`
instead. It sets `client_max_body_size 64m`, turns off
`proxy_request_buffering` and `proxy_buffering`, and leaves the requests that
carry a token out of the access log (`access_log … if=`), in
`/var/log/nginx/not-unreachable.access.log`. With SELinux enforcing, also let nginx connect to
the service: `sudo setsebool -P httpd_can_network_connect 1`.

## SMB shares

The installer installs `cifs-utils`, polkit, the root mount helper and its
`not-unreachable-mount@.service` unit. Nothing else is needed: the admin adds
SMB shares in the web app, and the service mounts them under
`/srv/not-unreachable/mounts/` with `nosuid,nodev,noexec` and SMB signing.

## Allowing folders from the admin interface

The service can write only to the local folders it has been allowed. By
default you allow one on the server with `sudo not-unreachable allow-folder
<path>`, and **Add resource → Local folder** shows that command when a folder
isn't allowed yet. `allow-folder` then checks that the `not-unreachable` user
itself may read, write and enter the folder (as owner, group or by an ACL, with
enter permission on every folder above it); if not, it still allows the folder
but warns what is missing and prints a command to fix it, such as `sudo setfacl
-m u:not-unreachable:rwx <path>`. You can let the admin allow folders from the
admin interface instead. It is off by default, and an upgrade never turns it on.

Turn it on or off on the server:

```sh
sudo not-unreachable allow-folders-from-ui on
sudo not-unreachable allow-folders-from-ui off
```

This sets `ALLOW_FOLDERS_FROM_UI` in `/etc/not-unreachable/config.env`,
installs or removes the polkit rule that lets the service start the folder
helper, and restarts the service. Don't change the key by hand: the rule
would not follow until the next install.

Only folders inside `ALLOWED_FOLDER_PREFIXES` in `config.env` can be allowed
this way; the default is `/srv,/mnt`. To change it, edit the line (absolute
folders, comma-separated) and restart the service with `sudo systemctl
restart not-unreachable`. `/` and system folders such as `/etc`, `/usr`,
`/var` or `/opt` are refused there, and the service doesn't start with one.

While it is on, **Add resource → Local folder** shows **Allow this folder**
beside the command. The admin enters their password and an authenticator code
or passkey, every time, even if they just signed in. The service then
restarts, which takes a few seconds; the page waits for it, checks the folder
again and goes on adding the resource. Each try is in the audit log, and a
success also emails the admin, once mail is set up.

It never allows `/`, a system folder or anything inside one, a folder outside
`ALLOWED_FOLDER_PREFIXES` (also through a symlink), the service's own
folders (`/var/lib/not-unreachable`, `/opt/not-unreachable`,
`/srv/not-unreachable/mounts`), or a folder inside or holding one the
service can already write to; allow those with `allow-folder`. The rule that mapped folders must not be
writable by other users of the server still applies.

The remaining risk: while it is on, someone with the admin's password and
second factor can make the service write to any folder inside those prefixes.
Keep the prefixes to folders that hold only data you mean to share.

`sudo not-unreachable allow-folder <path>` works as before, on or off, and for
any folder, inside the prefixes or not.

## Backups and restore

`not-unreachable-backup.timer` backs the database up every day (and at the next
boot after a missed day) into `/var/lib/not-unreachable/backups/`, keeping the
last 7. Back up by hand at any time with:

```sh
sudo not-unreachable backup
```

Copy the backups off the server by your own means. Files in shared folders and
SMB shares aren't in them: they are your own data.

> **Keep a copy of `/etc/not-unreachable/credentials/master.key` somewhere
> apart from the database backups.** The backups don't include it. Without it,
> the encrypted secrets in a backup (SMB passwords, authenticator apps, SSO and
> SMTP secrets) can't be recovered; passwords, passkeys and recovery codes
> still work.

To restore a backup:

```sh
sudo systemctl stop not-unreachable
sudo install -o not-unreachable -g not-unreachable -m 0600 \
  /var/lib/not-unreachable/backups/not-unreachable-<timestamp>.sqlite \
  /var/lib/not-unreachable/db/not-unreachable.sqlite
sudo rm -f /var/lib/not-unreachable/db/not-unreachable.sqlite-wal /var/lib/not-unreachable/db/not-unreachable.sqlite-shm
sudo systemctl start not-unreachable
```

On a new server, install first, then stop the service, put back the master key
(`root:root`, `0600`) and the database as above, and start it. Migrations bring
an older backup forward.

## Upgrade and rollback

Run the install command again:

```sh
curl -fsSL https://github.com/przemczan/not-unreachable/releases/latest/download/install.sh | sudo bash
```

or download and verify the newer tarball by hand, as above, and run its
`sudo ./install.sh`. It unpacks the new release next to the old one in `/opt/not-unreachable/`,
with its own installer in its `installer/` folder, switches `current` to it,
puts the new release's units, helpers and polkit rules in place (removing the
ones it doesn't ship) and restarts the service, which backs the database up
(`backups/pre-migration-<timestamp>.sqlite`) before it migrates. The config,
the master key and the data are left as they are. The release before is kept
for a rollback; older ones are removed. With
[updating from Settings](#updating-from-settings) on, the admin can also
install a newer release from **Settings → Updates**.

**The first signed release** must be installed over SSH, with the command
above or by hand: the release before it has no update helper, and the one-line
installer refuses a release without a signature.

To roll back to the previous release, stop the service, put the
pre-migration backup back if the upgrade migrated the database, and run the
previous release's own installer, which puts its system files back, switches
`current` to it and starts the service:

```sh
sudo systemctl stop not-unreachable
# Only if the upgrade migrated the database: put the pre-migration backup back.
sudo install -o not-unreachable -g not-unreachable -m 0600 \
  /var/lib/not-unreachable/backups/pre-migration-<timestamp>.sqlite \
  /var/lib/not-unreachable/db/not-unreachable.sqlite
sudo rm -f /var/lib/not-unreachable/db/not-unreachable.sqlite-wal /var/lib/not-unreachable/db/not-unreachable.sqlite-shm
sudo bash /opt/not-unreachable/<previous version>/installer/install.sh --yes
```

`ls /opt/not-unreachable` lists the releases kept; `readlink
/opt/not-unreachable/current` says which one is in use. When the new release
fails to start, the installer prints these commands with the version filled in.
A release from before releases kept their installer has no `installer/`
folder; for one of those, switch back by hand instead of the last command:
`sudo ln -sfn <previous version> /opt/not-unreachable/current`, then `sudo
systemctl start not-unreachable`.

## Updating from Settings

**Settings → Updates** shows the version running, the latest release and its
notes, and the commands to install it over SSH. You can let the admin install
a newer release from there instead. It is off by default, and an upgrade never
turns it on.

Turn it on or off on the server:

```sh
sudo not-unreachable update-from-ui on
sudo not-unreachable update-from-ui off
```

This sets `UPDATE_FROM_UI` in `/etc/not-unreachable/config.env`, installs or
removes the polkit rule that lets the service start the update helper, and
restarts the service. Don't change the key by hand: the rule would not follow
until the next install.

While it is on, **Install** beside a newer release asks for the admin's
password and an authenticator code or passkey, every time. The server
downloads the release from GitHub; a root helper with no network checks its
signature with the keys of the release in use, its checksum and that it is
newer, unpacks it, and installs it as an upgrade over SSH would. The service
restarts, and if the new release doesn't start or doesn't answer, it is rolled
back to the one before, with the database as it was. Each step and the result
show in **Settings → Updates**; each install is in the audit log, and the
admin gets an email, once mail is set up. Only signed releases newer than the
one in use can be installed, never an older one or the same one again.

If an update stops half-way, such as by a power cut, **Settings → Updates**
says so, and no other update starts until you run:

```sh
sudo not-unreachable update-recover
```

It rolls the half-done update back to the release before and waits until it is
done, whether updating from Settings is on or off. Installing over SSH ends
such an update too. If the rollback itself fails, the service stays stopped:
roll back by hand as in [Upgrade and rollback](#upgrade-and-rollback).

To check for new releases, the server asks GitHub's API for the latest release
every 6 hours, sending nothing about your server but its address. On a server
that must not reach GitHub, set `UPDATE_CHECK=false` in
`/etc/not-unreachable/config.env` and restart the service (`sudo systemctl
restart not-unreachable`): it then asks nothing, and nothing can be installed
from Settings.

## Uninstall

```sh
curl -fsSL https://github.com/przemczan/not-unreachable/releases/latest/download/install.sh |
  sudo bash -s -- --uninstall
```

or, from an unpacked tarball, `sudo ./install.sh --uninstall`.

It stops and removes the service, the backup timer, the mount, folder and
update helpers' units, the polkit rules, the CLI, `/opt/not-unreachable` and
`/var/lib/not-unreachable-update`. It keeps the config and the master key
in `/etc/not-unreachable` and the data in `/var/lib/not-unreachable`, so
installing again picks up where you left off.

To remove those too:

```sh
curl -fsSL https://github.com/przemczan/not-unreachable/releases/latest/download/install.sh |
  sudo bash -s -- --uninstall --purge
```

It asks you to type `delete everything` first, then also removes the list of
allowed folders and the service user. Node, `cifs-utils` and polkit stay; remove
them with your package manager if nothing else uses them.
