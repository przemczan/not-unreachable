# SMB access

**Decision: SMB shares are mounted by the kernel's `cifs` client (from
`cifs-utils`), through a small root-owned mount helper. The app starts and stops
the helper as systemd template units, with polkit allowing it exactly that and
nothing else.** Once mounted, a share is a directory like any local folder, so
one storage layer and one path-safety function serve both resource kinds.

## The options compared

### A. OS mounts (cifs)

- **Protocol support:** SMB 2.1 – 3.1.1, signing, encryption (`seal`),
  NTLMSSP and Kerberos, DFS, reconnect after network loss. It is the Linux kernel's
  own client, maintained alongside Samba.
- **Range and streaming:** whatever `fs` does on a local file: `pread` at any
  offset, `sendfile`, `fsync`, `rename` within the share. Range downloads and
  tus completion need no special code.
- **Privileges:** mounting needs `CAP_SYS_ADMIN` in the host's user namespace,
  so in practice root. An unprivileged service cannot mount, so something
  privileged has to do it for the app. The ways to do that:
  1. `/etc/fstab` entries or `.mount` units written by the install script:
     static, so the admin could not add a share from the UI.
  2. A setuid `mount.cifs` with `user` mounts in fstab: cifs-utils no longer
     builds it setuid by default, and the setuid path has a history of CVEs.
  3. **A dedicated helper started through systemd and gated by polkit**: the
     service never holds root. The helper is one small, dependency-free
     TypeScript file (about 200 lines), and the units it may run are limited
     by name.
- **Other needs:** the `cifs-utils` package and the `cifs` kernel module (both
  standard on Debian, Ubuntu, Fedora, RHEL and Arch). Containers need
  `--privileged` or `CAP_SYS_ADMIN`, so a Docker image is not a target of this
  Initiative.

### B. A userspace SMB client in Node

| Library | State (Nov 2026) | SMB 3.x / signing / encryption | Range and streaming |
|---|---|---|---|
| `smb2` (bchelli) | Unmaintained since 2016 | SMB 2.0.2 only, no encryption | Whole-file reads and writes |
| `@marsaud/smb2` (Vates / Xen Orchestra) | Lightly maintained, single user | SMB 2.x, no SMB 3 encryption | `createReadStream({ start, end })`, works |
| `v9u-smb2` and other forks | Forks of the above, sporadic | Same as the base | Same |
| `samba-client`, `node-smbclient` | Wrap the `smbclient` CLI | Whatever `smbclient` does | No real streaming; parses CLI output |
| libsmb2 (C) through N-API | No maintained Node binding | SMB 3 with signing and encryption | Would need our own native module |

- **Privileges:** none; it runs as the service user.
- **Problems:** no maintained pure-JS library speaks SMB 3.1.1 with
  encryption. Windows 11 24H2 and Windows Server 2025 require signing by
  default, and many NAS boxes now disable SMB 2.0/2.1, so the pure-JS options
  fail against current servers. Wrapping `smbclient` gives no proper
  streaming or Range support and adds a CLI-parsing attack surface. Writing our
  own binding means taking on a native security-critical module.
  Separately, every file operation would need a second implementation next to
  `fs`, and a second path-safety layer.

### Verdict

| | OS mount (chosen) | Userspace client |
|---|---|---|
| SMB 3.1.1 + encryption | ✅ | ❌ (no maintained library) |
| Range, streaming, rename, fsync | ✅ through `fs` | Partial, library-dependent |
| One storage code path | ✅ | ❌ two |
| Runs without root | ❌ needs the helper | ✅ |
| Adding a share from the UI | ✅ through the helper | ✅ |

We take on one small, testable privileged component in exchange for a mature
protocol stack and a single storage layer.

## Adding a share at runtime

### The admin's flow

**Admin → Resources → Add resource → SMB share.** Fields: *Name*, *Server* (host
name or IP), *Share*, *Folder in share* (optional), *Username*, *Password*,
*Domain* (optional), *Protocol* (`SMB 3.1.1` by default; `3.0` and `2.1` for
older servers), *Encrypt traffic* (on by default; it can be turned off for
3.1.1 and 3.0, and is always off for 2.1, which has no encryption). Whenever
traffic is not encrypted, the form and the Resources list show the warning
"Traffic to this share is not encrypted". **Test connection** mounts the share under a temporary id, lists
its top folder, and unmounts it, showing the result in plain words ("Signed in,
5 folders found" or "The server refused the user name or password"). **Save**
stores the resource (password encrypted, see
[threat-model.md](threat-model.md#t6-secrets-at-rest-smb-credentials-totp-seeds-smtp-and-sso-secrets))
and mounts it. Changing any connection field remounts the share. Removing the
resource unmounts it; this needs a recent sign-in.

### What happens underneath

```
app (not-unreachable user)                           root
──────────────────────────                           ────
1. write /run/not-unreachable/mount-requests/<id>.json   (0600, service user)
   { host, share, subfolder, username, password, domain, vers, seal }
2. systemctl start not-unreachable-mount@<id>.service  ──polkit──▶ allowed (name matches)
                                                     3. helper "mount <id>":
                                                        - <id> must be a UUID
                                                        - open mount-requests/ with O_NOFOLLOW and reach
                                                          the request through /proc/self/fd/<n>/
                                                        - open the request with O_NOFOLLOW | O_NONBLOCK,
                                                          then fstat: a regular file, owned by the
                                                          service user, mode 0600, size < 8 KiB
                                                        - delete the request (whatever happens next)
                                                        - validate every field (patterns below)
                                                        - write /run/not-unreachable-mount/<id>.cred (root 0600)
                                                        - mkdir /srv/not-unreachable/mounts/<id> (root-owned parent)
                                                        - mount.cifs //host/share \
                                                            /srv/not-unreachable/mounts/<id> -o <fixed options>
                                                        - delete the .cred file (in a finally block)
                                                        - exit 0, or an exit code naming the error
4. systemctl returns; on failure the app reads ExecMainStatus with
   `systemctl show`, maps it to "auth" | "unreachable" | "no-share" | …;
   on success it realpaths the mount point and the resource becomes available
```

- **The helper** is `/usr/lib/not-unreachable/mount-helper.mjs` (root `0644`),
  built from `deploy/mount-helper/` and run by the system's Node
  (`ExecStart=/usr/bin/node /usr/lib/not-unreachable/mount-helper.mjs mount %i`,
  `ExecStop=… unmount %i`, which unmounts and removes the empty mount point,
  so test mounts leave nothing behind) in `not-unreachable-mount@.service`
  (`Type=oneshot`, `RemainAfterExit=yes`). It imports only `node:` built-ins
  and `request-file.mjs` beside it (the request-file checks, shared with the
  folder helper of [deployment.md](deployment.md#allowing-folders-from-the-admin-interface)),
  and calls `mount.cifs` and `umount` through `execFile` with an argument
  array, with a fixed `PATH` and a 25-second timeout (short of the unit's
  30 seconds, so its `finally` blocks still run). It is about 470 lines in
  those two files, short enough for the security review to read in full.
  - *Why TypeScript and not shell:* the checks in step 3 need `open` with
    `O_NOFOLLOW` and `fstat` on the same descriptor, which a POSIX shell can't
    do. A shell helper would check the file and then read it by path, and a
    compromised service could swap in a symlink in between, making root read a
    file of its choosing. *Rejected:* POSIX shell (that race, and quoting);
    a compiled C helper (a second toolchain and a native binary to review).
- **The helper never writes into a directory the service user controls.** Root
  writing a file by path into such a directory could be redirected by a
  symlink onto any file on the host. So the result travels back as the exit
  code, the credentials file lives in the root-only `/run/not-unreachable-mount/`,
  and mount points live under the root-owned `/srv/not-unreachable/mounts/`
  (`root:root 0755`). Deleting the request file in the service's directory is
  safe: unlinking a symlink removes the link, not its target. The service could
  also swap `mount-requests/` itself for a symlink, so the helper opens that
  directory once with `O_NOFOLLOW` and opens and deletes the request through
  `/proc/self/fd/<n>/`, which stays on the directory it opened (Node has no
  `openat`). Before it writes anything, it checks that the mount root and
  `/run/not-unreachable-mount/` are real directories owned by root. It creates
  the credentials directory (`0700`) when it is missing. The install script
  creates both through `/usr/lib/tmpfiles.d/not-unreachable.conf`, which also
  makes `/run/not-unreachable-mount/` again at every boot.
- **Validation** in the helper (never trusting the app): the request is a
  UTF-8 JSON object with exactly these fields. host is
  `^[A-Za-z0-9.-]{1,253}$` or an IP literal. An IPv6 address can't carry a
  zone id; it goes to `mount.cifs` as `//[addr]/share` plus `ip=<addr>`. share
  is `^[^/\\:*?"<>|,=]{1,80}$`. subfolder is empty, or up to 1024 characters of
  `/`-separated segments, each `^[^/\\:*?"<>|,=]{1,255}$`, with no empty
  segments. Neither share nor a segment may be `.` or `..`. username and
  domain (domain may be empty) are `^[^,=\n\r]{1,104}$`. The password
  (1–256 characters) goes only into the credentials file, which needs no
  escaping beyond rejecting `\n`, `\r` and NUL. No text field but the password
  may hold a control character. `vers` is one of `3.1.1`, `3.0`, `2.1`, and
  `seal` is a boolean, ignored on 2.1. Commas and `=` are rejected so no field
  can inject a mount option. Error messages name the field, never its value.
- **Exit codes**, the helper's only answer. The app reads them with
  `systemctl show -p ExecMainStatus` and maps them to the reason the admin
  sees:

  | Code | Meaning | Reason shown |
  |---|---|---|
  | 0 | mounted, or unmounted | — |
  | 1 | internal: a bad credentials directory or mount root, no service user, an I/O error | `mount-failed` |
  | 2 | usage: not `mount <uuid>` or `unmount <uuid>` | `mount-failed` |
  | 3 | no request file | `mount-failed` |
  | 4 | request refused: a symlink, not a regular file, not the service user's, not `0600`, 8 KiB or more | `mount-failed` |
  | 5 | request invalid: not JSON, missing or unknown fields, a field fails its pattern | `mount-failed` |
  | 10 | the server refused the user name or password | `auth` |
  | 11 | the server couldn't be resolved or reached, or `mount.cifs` timed out | `unreachable` |
  | 12 | the server has no such share or folder | `no-share` |
  | 13 | the server doesn't support the protocol version or encryption asked for | `not-supported` |
  | 14 | `mount.cifs` failed for another reason | `mount-failed` |
  | 15 | `umount` failed | `mount-failed` |

  The app also logs codes 2–5 as a warning, since they mean it wrote something
  the helper wouldn't take. When `systemctl` can't run, or the unit fails with
  no helper status (polkit denied it, or the unit isn't installed), the reason
  is `helper-unavailable`. When `systemctl start` takes more than 30 seconds,
  the app stops the unit and the reason is `unreachable`.
- **`unmount <id>`** (the unit's `ExecStop`) also deletes any request or
  credentials file a run that never finished left for the id.
- **The request file and the credentials file** are the only places the
  password exists in clear text: both on tmpfs (`/run`), both `0600`, and both
  deleted within the one helper run, whether the mount works or not. The app
  deletes a request file the helper never picked up (for example after a
  timeout). The kernel keeps the credentials to reconnect, so neither file is
  needed afterwards.
- **The helper's own unit** must run in the host's mount namespace, or its
  mounts would stay inside the unit and never reach the host. So it uses no
  directive that gives the unit a mount namespace of its own: no
  `ProtectSystem=`, `ProtectHome=`, `PrivateTmp=`, `PrivateDevices=`,
  `ReadOnlyPaths=` and the like. Its hardening is what works without one:
  `NoNewPrivileges=yes`, a capability bounding set cut down to what
  `mount.cifs` needs (`CAP_SYS_ADMIN CAP_DAC_OVERRIDE CAP_DAC_READ_SEARCH`;
  the propagation test mounts with it and checks the unit has exactly this
  set), `RestrictAddressFamilies=AF_UNIX
  AF_INET AF_INET6 AF_NETLINK` (name resolution), `RestrictNamespaces=yes`,
  `RestrictRealtime=yes`, `LockPersonality=yes`,
  `SystemCallArchitectures=native`, `TimeoutStartSec=30s`, and an empty
  environment apart from `PATH`.
- **Polkit rule** (`/etc/polkit-1/rules.d/50-not-unreachable.rules`):

  ```js
  // not-unreachable (smb.md, "Polkit rule"): the service user may start and stop its SMB mount
  // units, one per lower-case UUID, and nothing else. Every other unit, verb and action falls through
  // to polkit's default, which denies the service user.
  polkit.addRule(function (action, subject) {
    if (action.id === "org.freedesktop.systemd1.manage-units" &&
        subject.user === "not-unreachable") {
      var unit = action.lookup("unit");
      var verb = action.lookup("verb");
      if (/^not-unreachable-mount@[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.service$/.test(unit) &&
          (verb === "start" || verb === "stop")) {
        return polkit.Result.YES;
      }
    }
  });
  ```

  Every other unit and verb falls through to polkit's default, which denies the
  service user.
- The app calls `systemctl --no-ask-password` with an argument array
  (`execFile`, never a shell) and a 30-second timeout. It writes the request
  file exclusively (`O_EXCL`, `0600`), and deletes it after `systemctl start`
  returns, in case the helper never picked it up.
- **The app's side** (`modules/resources`, the `smb` kind):
  - *Add* mounts the share before the row is saved. If the mount fails, nothing
    is saved and the form shows the reason. If the save fails, the unit is
    stopped again.
  - *Test connection* mounts under a temporary UUID, counts the top folder's
    folders, and stops the unit whatever happened. On a saved share with the
    password left blank, it uses the stored password.
  - *The stored password only goes to the server it was saved for.* Test
    connection or a change with another host and no password is refused (400)
    before anything is mounted, and the form asks for the password again.
    Otherwise whoever can change the host (a hijacked admin session) could
    point the share at a server of their own and collect a sign-in attempt to
    crack or relay.
  - *Changing a connection field* (host, share, subfolder, user name,
    password, domain, protocol, encryption) stops the unit, since starting an
    active unit does nothing, then mounts with the new settings. If that fails,
    the change is refused, and a share that was available is mounted again with
    its old settings. Changing only the name doesn't touch the mount.
  - *Change, Remove, Retry and the automatic retries* of one resource run one
    at a time: each stops or starts the same unit, and the helper mounts
    whichever request file it finds, so overlapping runs could mount the wrong
    settings or leave a removed share mounted.
  - *Remove* needs a recent sign-in and stops the unit, which unmounts the share.
  - The password is a secrets envelope (HKDF purpose `nu/smb`, AAD
    `resources:smb_password:<id>`), re-encrypted by `rotate-key`. Responses
    only say `smbPasswordSet`.
  - `resource.mount-failed` is audited, with the system as actor and the reason
    in its details, when a saved share fails to mount at startup, on Retry or
    on an automatic retry. A refused add, change or test isn't audited as a
    mount failure: the admin sees the reason in the form.

### Mount options

Set by the helper, never by the app:

```
vers=<3.1.1|3.0|2.1>,sign,[seal,]credentials=/run/not-unreachable-mount/<id>.cred,
uid=not-unreachable,gid=not-unreachable,forceuid,forcegid,
file_mode=0640,dir_mode=0750,nosuid,nodev,noexec,nounix,
soft,echo_interval=30,iocharset=utf8
```

- `sign`: packet signing is always required, so an attacker on the LAN cannot
  change traffic even when it is not encrypted. `seal` (encryption) is added
  unless the admin turned it off.

- `forceuid/forcegid` + modes: the service user owns everything it sees, and no
  other local user can read the mount (T14).
- `nosuid,nodev,noexec`: a share cannot bring device files or setuid binaries
  onto the host.
- `nounix`: no POSIX extensions, so the server cannot present symlinks or
  special files. The path-safety layer still rejects them if they appear.
- `soft`: a lost server gives an I/O error, which the app shows as
  "unavailable", instead of hanging requests.

### After a reboot or a lost connection

The mount units are not enabled at boot, since only the running app can decrypt
the credentials. When the server starts, the resources module mounts every SMB
resource. A share whose unit is still active from an earlier run (the service
was restarted, the host was not) and whose mount point is a `cifs` mount in
`/proc/self/mountinfo` is used as it is; an active unit without a mount is
stopped and started again. A share that fails is marked `unavailable` with the
reason, and retried after 1, 2 and 5 minutes, then every 10 minutes. A job
that runs every minute picks the retries that are due. The backoff is kept in
memory, so a restart starts it over. The admin sees the state on the
Resources page and can retry by hand. The kernel reconnects after short network
losses on its own.

### Mount propagation and the hardened service

The service runs in its own mount namespace (`ProtectSystem=strict` and
friends), which systemd sets up with *slave* propagation, so a mount made by
the helper in the host namespace appears inside the service. The mount root
`/srv/not-unreachable/mounts` is listed in the service's `ReadWritePaths=`, so
the service can write inside the shares.

`deploy/test/propagation.sh` proves this on an installed host, against a
Samba container, while the service runs:

1. As the service user, it writes a request file and starts a mount unit,
   so through the polkit rule, and checks the share is a `cifs` mount on the
   host.
2. From the service's own mount namespace (`nsenter` into its main process),
   as the service user, it checks the mount is there, lists it, and writes,
   reads back and deletes a file in it.
3. It checks the mount's options (`nosuid`, `nodev`, `noexec`, `forceuid`,
   `forcegid`, the service user's `uid` and `gid`, `sign`) and the helper
   unit's capability bounding set.
4. As the service user, it stops the unit, then checks the mount is gone on
   the host and inside the service, the mount point is removed, and the
   service kept the same main process throughout.

The CI workflow Install (`.github/workflows/install.yml`) runs it after a
full install on Ubuntu 24.04 (x64 and arm64, the job `install-ubuntu`) and on
AlmaLinux 9 with SELinux enforcing (the job `install-selinux`, through
`deploy/test/selinux-vm.sh`, in a VM, which also fails on any AVC denial
during the install or the test). The plain slave propagation is what ships. If a distribution's
systemd did not propagate into the `ReadWritePaths=` bind, the fallback would
be for the install script to make `/srv/not-unreachable/mounts` a shared mount
point of its own (a bind mount onto itself, marked shared, in a small `.mount`
unit ordered before the service). That unit is not shipped, and is added only
if the propagation test shows a supported distribution needs it.

## Testing

- **Unit:** the resources module with a fake mount runner (no root): the
  `smb` kind, the `systemctl` runner (argument arrays, exit-code mapping,
  timeout), the request files, the retry backoff and the routes.
- **Helper:** Vitest unit tests (`deploy/mount-helper/test/`, part of
  `pnpm test`) of its validation and options with a fake `execFile`: option
  injection like `host,uid=0`, newlines, `../`, non-UUID ids, a symlinked
  request directory, and the options for each protocol and encryption setting.
  They also check that the credentials file holds the right fields while
  `mount.cifs` runs, and that no request or credentials file is left after a
  mount that works or fails. A unit test evaluates the polkit rule against
  units and verbs it must allow and refuse.
- **Helper as root:** `pnpm test:helper-root` (`deploy/mount-helper/test-root/`,
  the CI job `mount-helper-root`, run with `sudo`, with `nobody` standing in
  for the service user) feeds the helper hostile requests: a symlink, a FIFO,
  a file owned by root or another user, the wrong modes, a file of 8 KiB or
  more, a hard link to a root-owned file, and a symlink swapped in while the
  helper runs. It also gives it a credentials directory or mount root that is
  a symlink or owned by the service user.
- **Integration:** `pnpm test:smb` (the CI job `smb`) runs against a Samba
  container (`ghcr.io/servercontainers/samba`, pinned) with an SMB 3.1.1 share
  that requires encryption. The job installs the helper, the unit and the
  polkit rule, and creates the service user. It then runs the test as that user
  from a copy of the checkout in `/var/tmp`: a wrong password and Test
  connection first, then add share → upload → Range download → delete →
  remove share. Afterwards it checks that no request file
  and no credentials file is left behind. It needs root, the `cifs` kernel
  module and a container runtime, so it runs only in CI.

## Owners

- **Resources** (Task 397cb6b6-e258-4e8d-8143-3ac08e74230a): the resources
  module, the request file and exit-code protocol, the admin screens, and the
  helper itself (it lives in `deploy/` but is part of the feature).
- **Install** (Task 1e20d309-2836-46ce-be58-757b7307d1f2): `install.sh`
  installs `cifs-utils` and polkit, the helper
  (`/usr/lib/not-unreachable/mount-helper.mjs`), the template unit, the polkit
  rule and the tmpfiles entry for the mount root and credentials folder; the
  CI workflow Install runs the propagation test.
