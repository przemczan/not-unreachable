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
     service never holds root. The helper is about 150 lines of reviewed shell,
     and the units it may run are limited by name.
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
*Domain* (optional), *Protocol* (`SMB 3.1.1` by default; `3.0`; `2.1` with the
warning "Traffic is not encrypted"), *Encrypt traffic* (on; can be turned off
only for 3.0). **Test connection** mounts the share under a temporary id, lists
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
                                                        - open request with O_NOFOLLOW; owner must be
                                                          the service user, mode 0600, size < 8 KiB
                                                        - validate every field (patterns below)
                                                        - write /run/not-unreachable-mount/<id>.cred (root 0600)
                                                        - mount -t cifs //host/share \
                                                            /var/lib/not-unreachable/mounts/<id> -o <fixed options>
                                                        - delete the .cred file and the request
                                                        - write /run/not-unreachable/mount-results/<id>.json
                                                          { ok, error: "auth" | "unreachable" | "no-share" | … }
4. read the result; realpath the mount point; resource becomes available
```

- **The helper** is `/usr/lib/not-unreachable/mount-helper` (root `0755`,
  installed from `deploy/`), run as `ExecStart=… mount %i` and
  `ExecStop=… unmount %i` by `not-unreachable-mount@.service`
  (`Type=oneshot`, `RemainAfterExit=yes`). It is plain POSIX shell over
  `mount.cifs`, `umount` and `jq`, so the security review can read all of it.
- **Validation** in the helper (never trusting the app):
  host `^[A-Za-z0-9.-]{1,253}$` or an IPv4/IPv6 literal; share
  `^[^/\\:*?"<>|,=]{1,80}$`; username and domain `^[^,=\n\r]{1,104}$` (the
  password goes only into the credentials file, which needs no escaping beyond
  rejecting a newline); `vers` one of `3.1.1`, `3.0`, `2.1`; `seal` boolean.
  Commas and `=` are rejected so no field can inject a mount option.
- **The credentials file** is the only place the password exists in clear text,
  for the time of one `mount` call. The kernel keeps the credentials to
  reconnect, so the file is not needed afterwards.
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
vers=<3.1.1|3.0|2.1>,[seal,]credentials=/run/not-unreachable-mount/<id>.cred,
uid=not-unreachable,gid=not-unreachable,forceuid,forcegid,
file_mode=0640,dir_mode=0750,nosuid,nodev,noexec,nounix,
soft,echo_interval=30,iocharset=utf8
```

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
resource. A share that fails is marked `unavailable` with the reason, and retried
after 1, 2, 5 and then every 10 minutes. The admin sees the state on the
Resources page and can retry by hand. The kernel reconnects after short network
losses on its own.

### Mount propagation and the hardened service

The service runs in its own mount namespace (`ProtectSystem=strict` and
friends), which systemd sets up with *slave* propagation, so a mount made by
the helper in the host namespace appears inside the service. The service has
`/var/lib/not-unreachable` as its `StateDirectory`; mounts go into
`/var/lib/not-unreachable/mounts/<id>`. **The Install Task must prove this with
a test** (mount from the helper, then list from inside the service). If a
distribution's systemd behaves otherwise, the fallback is to keep the mounts
outside the namespaced paths (`/srv/not-unreachable/mounts`) and add them with
`ReadWritePaths=`.

## Testing

- **Unit:** the resources module with a fake mount runner (no root).
- **Helper:** `bats` tests run as root in CI: validation rejects option
  injection (`host,uid=0`), newlines, `../` and non-UUID ids, and a symlinked
  request file.
- **Integration:** in CI, a Samba container (`ghcr.io/servercontainers/samba`)
  with an SMB 3.1.1 share that requires encryption; the job installs the helper,
  the unit and the polkit rule, then runs add share → upload → Range download →
  delete → remove share.

## Owners

- **Resources** (Task 397cb6b6-e258-4e8d-8143-3ac08e74230a): the resources
  module, the request/result protocol, the admin screens, and the helper itself
  (it lives in `deploy/` but is part of the feature).
- **Install** (Task 1e20d309-2836-46ce-be58-757b7307d1f2): installs
  `cifs-utils`, the helper, the template unit and the polkit rule, and runs the
  propagation test.
