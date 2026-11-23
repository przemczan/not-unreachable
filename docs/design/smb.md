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
  and calls `mount.cifs` and `umount` through `execFile` with an argument
  array. It is short enough for the security review to read in full.
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
  safe: unlinking a symlink removes the link, not its target.
- **Validation** in the helper (never trusting the app):
  host `^[A-Za-z0-9.-]{1,253}$` or an IPv4/IPv6 literal; share
  `^[^/\\:*?"<>|,=]{1,80}$`; username and domain `^[^,=\n\r]{1,104}$` (the
  password goes only into the credentials file, which needs no escaping beyond
  rejecting a newline); `vers` one of `3.1.1`, `3.0`, `2.1`; `seal` boolean.
  Commas and `=` are rejected so no field can inject a mount option.
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
  `mount.cifs` needs (`CAP_SYS_ADMIN CAP_DAC_OVERRIDE CAP_DAC_READ_SEARCH`,
  confirmed by the Install Task's test), `RestrictAddressFamilies=AF_UNIX
  AF_INET AF_INET6 AF_NETLINK` (name resolution), `RestrictNamespaces=yes`,
  `RestrictRealtime=yes`, `LockPersonality=yes`,
  `SystemCallArchitectures=native`, `TimeoutStartSec=30s`, and an empty
  environment apart from `PATH`.
- **Polkit rule** (`/etc/polkit-1/rules.d/50-not-unreachable.rules`):

  ```js
  polkit.addRule(function (action, subject) {
    if (action.id === "org.freedesktop.systemd1.manage-units" &&
        subject.user === "not-unreachable") {
      var unit = action.lookup("unit");
      var verb = action.lookup("verb");
      if (/^not-unreachable-mount@[0-9a-f-]{36}\.service$/.test(unit) &&
          (verb === "start" || verb === "stop" || verb === "restart")) {
        return polkit.Result.YES;
      }
    }
  });
  ```

  Every other unit and verb falls through to polkit's default, which denies the
  service user.
- The app calls `systemctl` with an argument array (`execFile`, never a shell)
  and a 30-second timeout.

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
stopped and started again. A share that fails is marked `unavailable` with the reason, and retried
after 1, 2, 5 and then every 10 minutes. The admin sees the state on the
Resources page and can retry by hand. The kernel reconnects after short network
losses on its own.

### Mount propagation and the hardened service

The service runs in its own mount namespace (`ProtectSystem=strict` and
friends), which systemd sets up with *slave* propagation, so a mount made by
the helper in the host namespace appears inside the service. The mount root
`/srv/not-unreachable/mounts` is listed in the service's `ReadWritePaths=`, so
the service can write inside the shares. **The Install Task must prove this
with a test**: mount from the helper while the service runs, then list and
write from inside the service, then unmount and check the service sees the
mount go. If a distribution's systemd does not propagate into the
`ReadWritePaths=` bind, the fallback is for the install script to make
`/srv/not-unreachable/mounts` a shared mount point of its own (a bind mount
onto itself, marked shared, in a small `.mount` unit ordered before the
service). The Install Task records which one it needed in deployment.md, and
the propagation test guards it.

## Testing

- **Unit:** the resources module with a fake mount runner (no root).
- **Helper:** Vitest unit tests of its validation with a fake `execFile`
  (option injection like `host,uid=0`, newlines, `../`, non-UUID ids), and a
  CI job that runs it as root against hostile request files: a symlink, a FIFO,
  a file owned by another user, a file over 8 KiB, and a symlink swapped in
  while the helper runs.
- **Integration:** in CI, a Samba container (`ghcr.io/servercontainers/samba`)
  with an SMB 3.1.1 share that requires encryption; the job installs the helper,
  the unit and the polkit rule, then runs add share → upload → Range download →
  delete → remove share.

## Owners

- **Resources** (Task 397cb6b6-e258-4e8d-8143-3ac08e74230a): the resources
  module, the request file and exit-code protocol, the admin screens, and the
  helper itself (it lives in `deploy/` but is part of the feature).
- **Install** (Task 1e20d309-2836-46ce-be58-757b7307d1f2): installs
  `cifs-utils`, the helper, the template unit and the polkit rule, and runs the
  propagation test.
