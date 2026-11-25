# Threat model

NotUnreachable is exposed to the Internet and holds the admin's files, so
security comes first. Each threat below gives its mitigation in enough detail to
test, and the Task that owns it. The [Security review](#owners) Task checks the
whole list against the built app and OWASP ASVS 5.0 level 2; its results are
in [docs/security/review.md](../security/review.md), and what remains is in the
[residual risk register](#residual-risk-register).

## Owners

| Key | Task |
|---|---|
| **Skeleton** | Project skeleton: monorepo, API and web shell, database, security baseline, CI (Task 94776ed7-0244-4ba0-bd52-a6cfbac33271) |
| **Accounts** | Local accounts and sessions with separate admin and user interfaces (Task cff653c2-aafd-4202-bf5d-1e78458708a8) |
| **Invitations** | Invitations and user management (Task 4723ccf9-fc28-4532-a186-8f099f09903e) |
| **2FA** | Two-factor authentication: authenticator app, recovery codes (Task 378c8142-5b80-4646-bd76-3455d34a1da1) |
| **Passkeys** | Passkeys (Task 520bfe57-4e16-448c-87ba-916a6e9ace9e) |
| **Resources** | Mapped resources: local folders, SMB shares and the home root (Task 397cb6b6-e258-4e8d-8143-3ac08e74230a) |
| **SSO** | Single sign-on with Google, GitHub and OIDC (Task 7bd5a230-b9f0-4679-aac9-fbc0909fe528) |
| **Files** | Files: browse, chunked uploads, resumable downloads, delete (Task 65765533-4396-4ae9-a6da-6780c2b84a29) |
| **Share links** | Share links: public, password-protected, with expiry (Task ccb26ec8-a7f9-46fa-8d98-c9f55fa4d4a1) |
| **Install** | Linux install script (Task 1e20d309-2836-46ce-be58-757b7307d1f2) |
| **Review** | Security review of the whole app, with fixes (Task f1f3aa6d-0023-4448-bbe0-cefb832cb17b) |
| **Allow folders** | Allow an admin to make a local folder usable from the UI (reauthenticated, restricted, off by default) (Task b6c18392-8072-47e1-9ce2-22994ca5289d) |
| **Updates** | Update the app from the admin's Settings, with signed releases (Task 559dde7a-8a27-4ff1-bf11-d10899e3bfca) |

## Assets

| Asset | Why it matters |
|---|---|
| Files in resources and homes | The reason the app exists; disclosure, tampering or deletion is the worst outcome. |
| The admin account | Full control of every resource, user and share link. |
| User accounts | Access to their home; a foothold for upload abuse. |
| SMB credentials | Often a Windows/NAS account with rights far beyond the mapped share. |
| The master key | Decrypts every secret in the database. |
| Session tokens, share-link tokens, invitation and re-link tokens | Each is a bearer credential. |
| TOTP secrets, recovery codes, passkey public keys | Second factors. |
| SMTP and SSO client secrets | Let an attacker send mail as the instance or impersonate it to the IdP. |
| The audit log | Evidence after an incident; must be complete and not editable from the app. |
| Where the service may write (the `resources.conf` drop-in) | `ProtectSystem=strict` keeps the service out of every folder it doesn't list. Adding one opens that folder to the app; while `ALLOW_FOLDERS_FROM_UI` is on, the admin interface can add one (T16). |
| The release signing keys | Whoever holds one and can also change this repository's GitHub Releases can get their code installed as root on every host that updates (T17). |
| The installed release and system files (`/opt/not-unreachable`, the units, helpers and polkit rules) | Root runs the helpers and the installer from them; while `UPDATE_FROM_UI` is on, the admin interface can replace them with a newer signed release (T17). |
| The host | The app must not become a way into the server or the LAN. |

## Trust boundaries

```
 Internet ──TLS──▶ reverse proxy ──HTTP (loopback)──▶ not-unreachable (service user)
                                                     │        │            │
                                         SQLite + data dir   local folders  /srv/not-unreachable/mounts/* (cifs)
                                                     │                          ▲
                                                     ├── D-Bus (polkit) ──▶ mount helper (root, one oneshot unit per share)
                                                     │                          │
                                                     │                   SMB server on the LAN
                                                     ├── D-Bus (polkit, only while the switch is on) ──▶ folder helper (root, one oneshot unit) ──▶ resources.conf
                                                     │
                                                     └── D-Bus (polkit, only while UPDATE_FROM_UI is on) ──▶ update helper, verify (root, offline)
                                                                                                                  │ root's own verified files only
                                                                                                                  ▼
                                                                                              update helper, apply (root) ──▶ /opt, units, helpers, rules
 not-unreachable ──HTTPS──▶ api.github.com, github.com (the update check and download; nothing that identifies the instance)
```

1. **Internet ↔ reverse proxy**: everything outside is untrusted. TLS ends here.
2. **Reverse proxy ↔ app**: the app trusts `X-Forwarded-*` only from the
   addresses in `TRUSTED_PROXIES` (see [deployment.md](deployment.md#tls-and-the-reverse-proxy)).
3. **App ↔ file system**: the app is trusted to stay inside its resources; the
   path-safety layer is the boundary.
4. **App ↔ mount helper and folder helper**: the only paths to root. The mount
   helper trusts nothing the app sends beyond a share id and a strictly
   validated request (see [smb.md](smb.md)). The folder helper is reachable
   only while `ALLOW_FOLDERS_FROM_UI` is on, and trusts nothing but its own
   config and its checks of the real path (T16). The update helper is
   reachable only while `UPDATE_FROM_UI` is on, and trusts nothing but its own
   config, the keys pinned by the installed release and its checks of the
   copies it made (T17).
5. **App ↔ IdPs and SMTP**: outbound TLS; responses are validated, never trusted.
6. **App ↔ GitHub**: the update check and the download. Answers and files are
   untrusted until the signature verifies with a pinned key (T17).
7. **Release workflow ↔ hosts**: a release is trusted because it is signed with
   a key kept in the protected `release-signing` environment or offline, not
   because it is on GitHub (T13, T17).

## Attackers

| Attacker | Can | Wants |
|---|---|---|
| **Anonymous Internet** | Reach every public route: sign-in, invitation and re-link pages, the share page, static assets. Automated scanners and credential stuffing. | Any account, files, a shell. |
| **Invited user** | Everything a user may do, with a valid session. Can upload arbitrary bytes and names. | Other homes, resources, the admin role, disk exhaustion, XSS against the admin. |
| **Holder of a share link** | Open that link's file or folder; guess passwords; reuse a leaked or expired link. | More than the link covers; other links. |
| **Network attacker** | Watch or change traffic between client and proxy, or proxy and SMB server on a hostile LAN. | Tokens, file contents, SMB credentials. |
| **Local OS user** (another account on the host) | Read world-readable files, see process lists, use local sockets. | The database, the master key, the mounts. |
| **Malicious dependency** | Run code at install or at runtime. | Secrets, a backdoor. |
| **Code running as the server process** (through a bug or a malicious dependency) | Everything the service user can: write the spool and the update request, start the update helper's verify unit while `UPDATE_FROM_UI` is on. | Root on the host; a backdoored or older, vulnerable release. |
| **Attacker on the release path** | Change files on this repository's GitHub Releases (a hijacked account or token, a compromised workflow), or answer for GitHub with a mis-issued certificate. | Their own code installed on every host that updates. |

The admin is trusted. The admin protects their own account with a second
factor; the instance can require it (see T10).

---

## T1. Authentication and account enumeration

| Mitigation | Test | Owner |
|---|---|---|
| Sign-in takes a username **or** email plus a password. Only the admin has a password; users sign in through SSO only (T9). Unknown, wrong-password, disabled and no-password accounts all answer the same `401 /problems/sign-in-failed` with the same body. For an account that has no password, the server still verifies against a fixed dummy argon2id hash, so the time taken is similar. A password proves only the admin's account: any other account, even one with a stored hash, is refused as `no-password`. | Integration test: the four cases give byte-identical bodies; timing differs by < 50 ms at p50 over 50 tries; a user with a stored hash gets the 401 of an unknown account. | Accounts |
| The sign-in delay and lock (T11) count an identifier that names no account exactly as they count an account, so a `429` never shows that an account exists, and both answer it as fast. Such an identifier is kept only as `HMAC-SHA-256(master key, identifier)`, normalised as the lookup does (trimmed, lower-case). | Integration test: the 6th attempt for an unknown identifier and for the admin give the same status, body and `Retry-After`; unit test: no plain identifier is stored. | Accounts |
| No public sign-up. The only ways to create an account are the first-run admin setup and an invitation. Users have no password, so there is no password reset: a user who lost their provider account gets back in through a re-link link (T9). | No route creates an account without a valid invitation token; test it. | Accounts, Invitations |
| Passwords: at least 12 characters, at most 256; no composition rules; refused if on a bundled list (SecLists 100k-most-used-passwords-NCSC, MIT licence, its entries of 12+ characters; offline, no network call). Hashed with argon2id (see [stack.md](stack.md#password-hashing-argon2id-through-node-rsargon2)), at most 4 hashes at once; a hash with older parameters is upgraded at sign-in. | Unit tests for limits and the breached list. | Accounts |
| Invitation, re-link and share-link pages answer the same "This link is not valid" for unknown, expired, used, revoked and malformed tokens: one byte-identical 404 (`invitation-invalid` for invitations and re-link links alike). | Integration test: the answers are byte-identical. | Invitations, Share links |
| An invitation's email is used only to send the link (when the admin chooses to), to check the provider's verified email (when the invitation requires it, T9) and as the new account's email when no account has it; it is never matched against an existing account. The identity is linked by (issuer, subject) alone (T9). Accepting is all or nothing (account, link, home, sign-in), serialised by a lock, and the claim is one conditional update, so a token works once even under parallel requests. Creating an invitation is refused (409 `home-root-not-set`) while no home root is set. | Integration tests: two parallel accepts, one wins; a failed accept leaves no account and no home folder. | Invitations |
| The first-run setup works only while no admin exists, and only with the one-time setup token from `not-unreachable setup-link` (valid 1 hour, single use, stored as SHA-256; `setup-link` refuses once an admin exists and replaces any earlier token). While no admin exists every page redirects to `/setup`. After `reset-admin` the same page, with an admin-reset token, sets a new password for the existing admin (see [deployment.md](deployment.md#first-admin)). | Test: once an admin exists, a first-run token is refused and `setup-link` refuses. | Accounts |
| Changing the password or email needs a recent sign-in. A password change signs out every other session. | Integration test. | Accounts |

## T2. Sessions

| Mitigation | Test | Owner |
|---|---|---|
| Server-side sessions. The token is 32 random bytes (`crypto.randomBytes`), base64url, sent only in the cookie. The database holds only its SHA-256. | Unit test: no token in DB rows. | Accounts |
| Cookie: `__Host-nu_session`; `Secure; HttpOnly; SameSite=Strict; Path=/`; no `Domain`; no `Max-Age` (a browser-session cookie, as timeouts are server-side). `Strict` costs nothing here: the SPA's HTML needs no cookie, and its API calls are same-site, so a user arriving from an email link or an SSO redirect is still signed in once the app loads. | Integration test on `Set-Cookie`; Playwright (`e2e/sessions.spec.ts`): arriving from a cross-site link keeps the session. | Accounts |
| **Rotation**: a new token is issued (and the old one revoked) at sign-in, when the second factor is passed (`pending second factor` → `active`), when the password changes, and when a recent sign-in is renewed (`POST /api/v1/session/confirm`). | Integration test: the token before ≠ the token after each event, and the old one returns 401. | Accounts, 2FA |
| **Idle timeout**: 30 minutes for the admin, 2 hours for a user (settings, lower bound 5 minutes). **Absolute timeout**: 12 hours for the admin, 7 days for a user. A `pending second factor` session lives 5 minutes and has no recent sign-in. `last_seen_at` is written at most once a minute. | Clock-injected unit tests. | Accounts |
| **Recent sign-in** (10 minutes) is required for: changing the password or email, adding or removing a second factor, regenerating recovery codes (they are shown once and never again), linking or unlinking SSO, and for the admin: adding or editing a resource, SSO provider or SMTP settings, deleting a user. It is renewed by `POST /api/v1/session/confirm` with the password or, for the admin, an authenticator code or a passkey (a wrong code answers 401 `second-factor-failed`, counts in the T10 try limits, and does not revoke an active session; 429 past the limits). | Integration test per route (route table flag `recentSignIn: true`). | Accounts, 2FA |
| Sign-out revokes the session on the server and clears the cookie. **Settings → Sessions** lists the account's sessions and signs out any one or all. Disabling an account revokes all its sessions. There is no limit on concurrent sessions per account; Settings → Sessions lists them all. | Integration test. | Accounts, Invitations |

## T3. CSRF

| Mitigation | Test | Owner |
|---|---|---|
| `SameSite=Strict` session cookie (T2). | – | Skeleton |
| For every request whose method is not `GET`, `HEAD` or `OPTIONS`: reject with 403 unless `Origin` equals `PUBLIC_ORIGIN` exactly, or, if `Origin` is absent, `Sec-Fetch-Site` is `same-origin`. If both are absent, reject. | Integration tests with a foreign, `null` and missing origin. | Skeleton |
| State-changing requests also need the custom header `X-NU-Request: 1`, which a cross-site form cannot send and a cross-site `fetch` cannot send without a preflight. | Integration test. | Skeleton |
| No CORS: the app never sends `Access-Control-Allow-*`. | Integration test: preflight gets no allow headers. | Skeleton |
| `GET` routes never change state (checked in review; the route table marks them `safe`). | Contract test over the route table. | Skeleton |
| SSO callbacks (cross-site `GET` by design) are protected by `state` + PKCE, bound to a `__Host-nu_sso` cookie (`SameSite=Lax`, 10 minutes, single use). | See T9. | SSO |

*Rejected:* synchronizer tokens (`@fastify/csrf-protection`). With a same-origin
SPA, no CORS, a Strict cookie and origin checks, a token adds state and adds no
protection.

## T4. XSS and the CSP

| Mitigation | Test | Owner |
|---|---|---|
| CSP on every HTML response: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; require-trusted-types-for 'script'; trusted-types 'none'`. No `unsafe-inline`, no `unsafe-eval`, no nonces needed. | Integration test on headers; Playwright: no CSP violations reported on any screen. | Skeleton |
| The build makes the CSP possible: Vite emits no inline scripts; fonts are self-hosted in the design-system package; React's `style` props are set through the CSSOM, which `style-src 'self'` allows. | Build test: `index.html` has no inline `<script>` or `<style>`. | Skeleton |
| React escapes output. `dangerouslySetInnerHTML` is a lint error (`react/no-danger`), as are `eval`/`new Function` (`no-eval`, `no-new-func`). | Lint. | Skeleton |
| File contents are never rendered by the app. Every download, admin, user and share link alike, is sent with `Content-Disposition: attachment; filename*=UTF-8''…`, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox; default-src 'none'`, so an uploaded HTML or SVG file cannot run script on our origin. | Integration test with an uploaded `.html` and `.svg`. | Files, Share links |
| File and folder names are shown only as text nodes; `title` and `aria-label` attributes get them through React props. | Unit test of the file browser (jsdom): names like `<img src=x onerror=alert(1)>.txt` render as text only. | Files |
| Audit-log details, user agents and SSO profile fields are shown as text only. | Unit test of the audit table component. | Accounts |

## T5. Path traversal, symlinks and special files

**One function, used for every path:** `storage.resolveInResource(root, relative)`
(see [domain.md](domain.md#path-safety)). It is the only way to get a
`ContainedPath`; the file system API of the `storage` module accepts nothing
else. Steps:

1. **Reject the input** if it contains a NUL byte, a backslash, a control
   character (`< 0x20`, `0x7F`), or a segment that is `.` or `..`; if it is
   absolute; if it is longer than 4096 bytes, or a segment longer than 255
   bytes. Normalise Unicode to NFC. Collapse duplicate `/` and drop the
   leading and trailing `/`.
2. **Join** with the resource root, whose real path was fixed when the
   resource was saved (`fs.realpath`, and re-checked at startup).
3. **Walk segment by segment** with `lstat`. If any existing segment is a
   symbolic link, reject. **Symlinks are never followed**, and appear in
   listings only greyed out, as "link (not followed)".
4. **Containment check:** `realpath(deepest existing ancestor)` must equal the
   root or start with `root + "/"`.
5. **Open** with `O_NOFOLLOW` (and `O_DIRECTORY` for folders), then `fstat` the
   descriptor: only regular files and directories pass; FIFOs, sockets and
   devices are rejected. Then read `/proc/self/fd/<fd>` and repeat the
   containment check on the result. This closes the race where a segment is
   swapped for a symlink between steps 3 and 5.
6. All reads and writes then use the **file handle**, never the path again.
7. **New names** (upload, create folder, rename) also pass the name rules: not
   empty, not `.` or `..`, no `/`, no trailing dot or space, no Windows-reserved
   names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`) or characters
   (`<>:"|?*`), because they break SMB shares.
8. **Users** pass their home as the root, never the home root. A user's
   requests carry no resource id at all. A new home is always a folder the
   server creates; a name already in the home root is refused.

| Mitigation | Test | Owner |
|---|---|---|
| The steps above. | Table-driven tests: `../`, `%2e%2e/` (decoded by Fastify first), `a/../../b`, `..\\`, absolute paths, NUL, overlong names, NFD names, a symlink to `/etc`, a symlink to a sibling home, a FIFO, a device, and a race test that swaps a folder for a symlink between resolve and open. | Resources |
| Hard links inside a resource that point outside it can only be made by someone with shell access (no route creates links). Documented as a residual risk for the local OS attacker. The installer, when it asks for the folders to allow, and [docs/install.md](../install.md#install) both say to map only folders that other OS users cannot write to; nothing checks it. | Review. | Resources, Review |
| SMB mounts use `nosuid,nodev,noexec` and fixed `uid`/`gid` (see [smb.md](smb.md#mount-options)), so a share cannot add a device file or a setuid binary to the host. | The propagation test (`deploy/test/propagation.sh`, in the CI workflow Install) checks the live mount has `nosuid`, `nodev`, `noexec`, `forceuid`, `forcegid`, the service user's `uid`/`gid` and `sign`. | Install |
| The lint rule `no-restricted-imports` forbids `node:fs` and `node:fs/promises` outside `modules/storage`, `modules/platform`, the files module's staging store (`modules/files/staging.ts`), the resources module's mount-request writer (`modules/resources/mount-requests.ts`) its folder-request writer (`modules/resources/folder-requests.ts`) and the updates module's spool (`modules/updates/spool.ts`, T17). The `resources.conf` writer is the helpers' `folder-access.mts` (`deploy/mount-helper/`), run only as root, by the CLI command `allow-folder` and by the folder helper (T16). | Lint. | Skeleton, Resources, Updates |
| `ContainedPath` is branded and every `storage` operation also checks at run time that it was made by `resolveInResource` (a registry of the values it made), so a cast can't forge one. After the checked open, operations reach the entry through `/proc/self/fd/<fd>`, so a later swap can't redirect them. `remove` never follows a symlink and re-checks containment before entering each folder. | Unit tests: a forged path is refused by every operation; `remove` of a tree with nested symlinks leaves their targets alone. | Resources |

## T6. Secrets at rest: SMB credentials, TOTP seeds, SMTP and SSO secrets

| Mitigation | Test | Owner |
|---|---|---|
| **Envelope encryption** with AES-256-GCM (`node:crypto`). The format is version (1 byte) ‖ key id (4 bytes) ‖ nonce (12 random bytes) ‖ ciphertext ‖ tag (16 bytes), stored as base64url. **AAD** = `table:column:rowId`, so a ciphertext copied into another row or column fails to decrypt. | Unit tests: round-trip, a tampered byte fails, a swapped row fails. | Skeleton (the `secrets` module), Resources (first use) |
| **The key lives outside the database**: a 32-byte master key in `/etc/not-unreachable/credentials/master.key` (`root:root 0600`), handed to the service through systemd `LoadCredential=`, so the service reads it from `$CREDENTIALS_DIRECTORY` and the service user has no access to the file itself. Per-purpose keys are derived with HKDF-SHA-256 (`info = "nu/smb"`, `"nu/totp"`…). A backup of the database alone discloses no secret. The install script makes the key once, from `/dev/urandom`, in the `root:root 0700` folder `credentials/`, and links it into place with `ln`, which refuses an existing name, so a re-run or a second install at the same time never replaces a key. | Startup test: the server refuses to start without the credential, and never logs it. The install's mode audit fails unless the key is a 32-byte `root:root 0600` file; `deploy/install/` tests that an upgrade leaves it untouched. | Skeleton, Install |
| **Rotation**: `not-unreachable rotate-key` (run as root with the service stopped) re-encrypts every envelope under a new key id. | CLI integration test. | Skeleton |
| Secrets never leave the server: the API returns `smbPasswordSet: true`, never the value. The one exception is the TOTP `setupKey` in the enrolment answer, before the app is confirmed; a TOTP secret is never audited or logged. Editing a resource without typing a new password keeps the old one, but a stored SMB password is only ever sent to the host it was saved for: changing the host, or testing another one, needs the password again, so an admin session alone can't send it to a server of the attacker's. The same holds for the SMTP password: changing the SMTP host needs the password again; and for an SSO client secret: changing a provider's issuer needs the secret again. | Contract test: no response schema has a secret field. Resources test: another host without a password is refused before any mount. Mail and SSO tests: a changed host or issuer without the secret is refused. | Resources, 2FA, SSO |
| Passwords, recovery codes and share-link passwords are **hashed** (argon2id), not encrypted. Session, invitation, re-link and unlock tokens are stored as SHA-256 (they are already 256-bit random, so a slow hash adds nothing). Invitation and re-link tokens are also kept as an envelope (HKDF purpose `nu/invitation`, AAD `invitations:token:<id>`, re-encrypted by `rotate-key`), so the admin can copy the link again. The SMTP password is an envelope too (purpose `nu/smtp`, AAD `mail_settings:password:smtp`). | Unit tests. | Accounts, 2FA, Invitations, Share links |
| SMB passwords reach the kernel through two short-lived files on tmpfs: the app's request file (`0600`, service user) and the credentials file the mount helper writes (`root 0600`). The helper deletes both within the same run, whether the mount works or not (see [smb.md](smb.md#adding-a-share-at-runtime)). Passwords never appear on a command line or in the environment. | Helper test: after a successful and a failed mount, neither file exists. | Resources, Install |

## T7. Upload abuse

| Mitigation | Test | Owner |
|---|---|---|
| **Quota per user** (default 10 GiB, the `defaultQuotaBytes` setting; the admin can set `quota_bytes` per user). Checked at tus creation with the declared `Upload-Length`, counting the home's used bytes plus that user's unfinished uploads at their declared size; checked again when the last chunk arrives. The admin has no quota, but the disk-reserve rule below applies to the admin too. | Integration test: an upload declared over quota gets `413 /problems/quota-exceeded` before any byte is stored. | Files |
| **Size limit per file** (default 50 GiB, the Limits tab) and `Upload-Length` required (no deferred length: `400 upload-length-required`). A file over the limit gets `413`. Each `PATCH` body is at most 64 MiB (`413` past it); the client uses 16 MiB chunks. | Integration test. | Files |
| **Disk reserve**: an upload is refused with `507 /problems/insufficient-storage` if it would leave less than 5 % or 5 GiB free on the staging disk or on the target (`statfs`), at creation, and on the target again at the last chunk. Both numbers are in the Limits tab. | Integration test with a faked `statfs`. | Files |
| **At most 4 uploads in progress per account** and 100 per instance; at most 20 new uploads per account per hour (counted in memory, so a restart clears it). Past any of them: `429 /problems/too-many-uploads` with a `reason`, and `Retry-After` for the hourly one. All three are in the Limits tab. | Integration test. | Files |
| **Ownership**: `HEAD`, `PATCH` and `DELETE` on an upload work only for the account that created it; any other, and an expired one, answers `404`. | Integration test. | Files |
| **Cleanup**: an unfinished upload expires 24 hours after its last chunk. An hourly job (its first run at startup) deletes expired uploads with their staged files, removes staged files that have no row, and removes the `.nu-upload-*` temporary file of an upload whose last chunk came more than 1 hour ago, found through the `temp_name` on its row, not by scanning targets. | Clock-injected test. | Files |
| Upload metadata (target, name, `onConflict`) is validated at creation by T5's rules, so a bad target is rejected before any data is accepted. | Integration test. | Files |
| Staging lives in `DATA_DIR/uploads`, outside every resource and the web root; the folder is `0700` and staged files are `0600`. | The install's mode audit checks the folder's owner and mode; `deploy/install/` tests the layout. | Files, Install |
| Downloads of uploaded content never render on our origin (T4). | Integration test: uploaded .html and .svg on every download kind. | Files |

## T8. Share-link abuse

| Mitigation | Test | Owner |
|---|---|---|
| **Token**: 32 random bytes (256 bits), base64url (43 characters), in the path: `/s/<token>`. Looked up by SHA-256. The token is also kept encrypted (T6), so the admin can copy the link again. It is never logged: pino cuts the token out of `/s/`, `/api/v1/public/share-links/`, `/invitation/`, `/relink/`, `/api/v1/invitations/` and `/api/v1/relink/` URLs, and drops the SSO callback's whole query. | Unit test of the redaction; integration test of the request log over every such URL (`request-logging.test.ts`). | Share links |
| `Referrer-Policy: no-referrer` everywhere, so the token never leaks through `Referer`. | Header test. | Skeleton |
| **Link password**: optional, at least 8 characters, hashed with argon2id. A correct password creates an **unlock**: a random token in the cookie `__Host-nu_unlock_<linkId>` (`Secure; HttpOnly; SameSite=Strict; Path=/`), valid 12 hours or until the link expires, stored as SHA-256. Changing or removing the password deletes every unlock. | Integration test. | Share links |
| **Link access** (domain.md): Anyone with the link, Signed-in users or Selected users (the listed users and the admin). Every public share request checks, in this order: the token (unknown, malformed, expired, revoked or gone → the same 404, T1), then the link access, then the link password. Signed-in means a session in state `active`; one still waiting for its second factor counts as signed out. Without one, a restricted link answers 401 `share-link-sign-in-required`; a signed-in account the link isn't shared with gets 403 `share-link-not-allowed`, even with a valid unlock. Neither answer names the item, its kind or its size: they only confirm that the token is valid, to someone who already holds it. The check runs on every request, each range request included, so changing the access or the list, or removing a user (which takes them off every list), takes effect on the next request. A restricted link's downloads record the signed-in account as the actor of `share-link.downloaded`. | Integration tests (`share-links.public.test.ts`). | Share links |
| **Expiry**: default 7 days, chosen when the link is made; "No expiry" exists but has to be picked on purpose, and the link list marks those links. Expiry is checked on every request, including each range request of a download in progress; an expired link answers like an unknown one (T1). | Clock-injected test. | Share links |
| **Rate limits** on the public share API: unknown or invalid tokens: 20 per minute per IP (IPv6 by /64), then 429 for 15 minutes. Wrong link password: 5 per 15 minutes per IP per link, and 50 per hour per link across all IPs. After that the link locks for an hour: the audit log records `share-link.locked`, and the Share links list shows the link with a **Locked** badge until the hour is over. Expired, revoked and gone links count as invalid tokens too, as they answer like one. Every wrong password is audited as `share-link.password-failed`, and the first 429 of each block as `rate-limit.triggered`. The counters are kept in memory (one process), so a restart clears them; the lock is kept in `share_links.locked_until`, so a restart never lifts it. The lock is per link, so anyone holding the token can lock it for everyone for an hour; that is the price of capping guesses across all IPs. The numbers are the `shareLinkLimits` setting (T11). | Integration tests. | Share links |
| **Scope**: a folder link uses the shared folder as the root for T5, so `..` and symlinks cannot leave it. A link for a file allows only that file. | Path-safety tests run through the share API. | Share links |
| **Revocation** takes effect on the next request, including a download in progress at its next range request. | Integration test. | Share links |
| **Download cost**: at most 4 concurrent downloads per link per IP (IPv6 by /64); a fifth gets 429 `too-many-downloads`. A slot comes back when the download ends, fails or the client goes away. **Download count**: a GET with no `Range`, or with a range starting at byte 0, counts as one download: it increments `download_count`, sets `last_used_at` and records `share-link.downloaded`. A resumed download (a later range) and `HEAD` are not counted, so resuming never inflates the count. The count is shown in the link list. | Integration test. | Share links |
| The share page is `noindex` (`X-Robots-Tag: noindex, nofollow`) and does not say which resource or path the link points into, only the shared item's own name. | Header test; Playwright. | Share links |
| **Shared with me** (domain.md): `GET /api/v1/share-links/shared-with-me` (role `user` only; the admin gets 403) lists the caller's links: active (not revoked, not expired) **Signed-in users** links, and active **Selected users** links whose list has the caller, found from the session, never from the request. It shows a user only links they could open already, and holds what their share page shows anyway: the item's own name, its kind, its expiry, whether it has a password, and the link itself. Never the resource, the path, the link access or the allowed users. **Anyone with the link** links never show: they have no audience to list them for, and the token stays with whoever the admin gave it to. Opening a row goes through `/s/<token>`, so the link password, the lock, the rate limits and the download limits all apply as above. Listing records no audit event, as it is a read. | Integration tests (`share-links.shared-with-me.test.ts`); Playwright. | Share links |

*Rejected:* putting the token in the URL fragment, which keeps it out of proxy
logs. Resumable downloads by download managers need a plain, stable URL. The
proxy examples (`deploy/proxy/`) instead keep every URL that carries a token
(share links, invitations, re-links, the SSO callback) out of the access log,
matched on the decoded path; `deploy/install/test/proxy.test.ts` checks both.

## T9. SSO account linking

| Mitigation | Test | Owner |
|---|---|---|
| **No auto sign-up and no linking by email.** An SSO identity signs in only if a linked sign-in for its (issuer, subject) exists; links are matched and unique by that pair only. A matching email alone never *links* anything, because not every IdP verifies emails and some let users change them: the email is kept for display only. An invitation may still *require* a verified one before it is accepted (last row). An unknown identity, a disabled provider and a disabled account all get the same answer (a 303 to `/sign-in?error=sign-in-failed`); only the audit log records why. | Integration test: an unknown subject with the admin's email is refused, with an answer identical to the disabled-user and disabled-provider refusals. | SSO |
| A link is made in only three ways: (a) in **Settings → Linked sign-ins** with a recent sign-in, by the account's own session (the flow carries it, as the Strict session cookie isn't sent on the provider's cross-site redirect); (b) on the invitation page, by choosing **Continue with <provider>**, which creates the account and the link in one go; (c) with a **re-link link** the admin made for that user (valid 1 day, single use, needs the admin's recent sign-in): it links a new identity, removes the account's old linked sign-ins, revokes all the user's sessions and signs them in. An identity linked to any account is refused. | Integration tests. | SSO, Invitations |
| Authorization code flow with PKCE (S256), `state` and `nonce` (OIDC), bound to the `__Host-nu_sso` cookie (`SameSite=Lax`, 10 minutes, single use: the flow is deleted at the callback whatever happens next). ID token: signature, `iss`, `aud`, `exp`, `nonce`. The redirect URI is fixed to `PUBLIC_ORIGIN + /api/v1/sso/<providerId>/callback`. GitHub is OAuth 2: the constant issuer `https://github.com` and the numeric user id as the subject. | Tests with a fake OIDC provider and a fake GitHub (jose-based, so they can also forge bad tokens). | SSO |
| An SSO sign-in is a first factor only for the admin, whose session is always left pending the second factor (T10), whatever the provider. Users have no second factor of their own and rely on their provider's MFA: their SSO sign-in is complete, with a recent sign-in. | Integration test. | SSO |
| A user can't unlink their last linked sign-in, as it is their only way to sign in; the admin, who has a password, may unlink any. | Integration test. | SSO |
| A disabled SSO provider stops sign-in at once; its links stay so they work again if it is re-enabled. A provider with links can't be removed, only disabled, and its issuer can't change, as the links match on it. | Integration test. | SSO |
| The per-IP sign-in limits (T11) also count SSO starts and callbacks. | Integration test. | SSO |
| **Email verification on invitations.** The admin chooses, when creating an invitation, whether it is emailed (`send_by_email`: needs an email and SMTP set up, 409 `smtp-not-configured` otherwise) and whether it requires a verified email (`verify_email`: needs an email). An emailed invitation always requires it; the server refuses the request otherwise (400), so a link that went to a mailbox can't be used by whoever else gets hold of it. Accepting such an invitation needs the provider to report, as verified, an email equal to the invitation's (both trimmed and lowercased, no other folding), checked at the callback before the home folder or account is made. GitHub: any address `/user/emails` marks `verified`, not only the primary one. OIDC (Google, generic): the ID token's `email` only when `email_verified` is `true` (or the string `"true"`); a provider that never sends `email_verified`, such as Microsoft Entra, can't accept these invitations. No verified email gives `email-not-verified`, a different one `email-mismatch`: the browser goes back to the invitation page with that `?error=`, nothing is created, the invitation stays pending, and `invitation.refused` (outcome `denied`, details `reason`, `providerId`) is audited without the provider's emails. The public page says verification is needed but never shows the invitation's email. Resend works only for emailed invitations. Without verification, accepting is as before: the invitation's email is the admin's word. Re-link links never check email. | Integration tests (`invitations.test.ts` › Invitations that require a verified email): a match whatever the case and spaces; a GitHub secondary verified email; an unverified email, an ID token without `email_verified` and a different email are refused with no account, home or link, and audited; inconsistent requests and sending without SMTP are refused. | Invitations, SSO |

## T10. Second-factor bypass and recovery

| Mitigation | Test | Owner |
|---|---|---|
| Between password and second factor, the session is `pending second factor`, for at most 5 minutes. It reaches only the ten second-factor sign-in routes (step, authenticator code, recovery code, passkey options and answer, the two authenticator-app and two passkey enrolment routes, acknowledging recovery codes), sign-out and `GET /api/v1/session` (so the SPA can see its state); every other route refuses it (the guard checks `state === "active"`). | Contract test over the route table: every other route has the `active` guard, and the pending list is exactly those routes. | 2FA |
| **Admin only.** Only the admin has a password, and the admin always needs a second factor; there is no setting to turn it off. Users sign in with SSO and rely on their provider's MFA. There are no email codes. | Contract test `sign-in-methods.test.ts`. | 2FA |
| **Enrolment.** An admin with no confirmed factor (after setup, or after `reset-admin --second-factors`) gets a pending session in `enrol` mode: QR code and setup key and a confirming code, or a passkey instead, then 10 recovery codes to save, and only then is the session active. The enrolment routes answer 409 once a confirmed factor exists, so a pending session can't add its own factor. An unconfirmed enrolment is void after 10 minutes. | Integration tests. | 2FA |
| TOTP (`otpauth`: SHA-1, 6 digits, 30 s): ±1 step, each step accepted once (`last_used_step`, updated atomically). Codes are compared in constant time (`crypto.timingSafeEqual`). The secret is a secrets envelope (HKDF purpose `nu/totp`, AAD `totp_credentials:secret:<id>`), re-encrypted by `rotate-key`. | Unit tests. | 2FA |
| Wrong codes are limited to 5 per 15 minutes per session and 10 per hour per account; past either, the pending session is revoked (`session.revoked`, reason `second-factor-limit`) and the answer is 429. Every wrong code is audited as `second-factor.failed` (method, during `sign-in`, `enrolment` or `confirm`, `limitReached`). Second-step tries of one account run one at a time. | Integration test, including a burst of parallel wrong codes counted one by one. | 2FA |
| **Recovery codes**: 10 codes of 10 base32 characters (50 bits each, shown as `ABCDE-FGH23`), shown once, created with the first factor, argon2id-hashed, single use. Using one records `second-factor.recovery-code-used` (with how many remain). They can only be regenerated, which needs a recent sign-in, voids all earlier codes and records `recovery-codes.regenerated`. | Integration tests. | 2FA |
| **Settings → Two-step sign-in**: the admin may add more authenticator apps (each confirmed by a code) and passkeys, rename a passkey, and remove a factor, but not the last second factor of any kind (409). Adding and removing need a recent sign-in and are audited (`second-factor.added`, `second-factor.removed`). | Integration test. | 2FA |
| **Security notices** (recovery code used, factor added or removed, lock) go through a `notify()` seam and are emailed to the account holder once SMTP is set (always audited). A mail failure is logged and never fails the action. | Unit test. | 2FA |
| **Lost provider account (user)**: a user can't unlink their last linked sign-in, and has no password. The admin sends a **re-link link** from the Users screen (T9); the user signs in once through a new provider account and the old links are gone. | Integration test. | Invitations |
| **Lost all factors (admin)**: there is no web path. On the host, `sudo not-unreachable reset-admin [--password] [--second-factors] [--yes]` asks the operator to type the admin's username (without `--yes`; without a terminal and without `--yes` it refuses) and revokes every admin session. `--password` (the default when neither option is given) deletes the password credential and prints a one-time `PUBLIC_ORIGIN/setup#<token>` link, where `/setup` sets a new password for the existing admin. `--second-factors` deletes the authenticator apps, passkeys and recovery codes, recording `second-factor.removed` per factor (actor `system`, reason `reset-admin`), and clears the account's wrong-code tries so the try limits don't hold up the new enrolment. Both can be combined. `admin.reset` (actor `system`) lists the removed sign-in methods. The next sign-in forces enrolment. Shell access to the host is the proof. | CLI test. | Accounts, 2FA |
| **Passkeys** (WebAuthn, `@simplewebauthn` 13). The RP ID is the host of `PUBLIC_ORIGIN` and the origin must equal `PUBLIC_ORIGIN` exactly. Every challenge (`webauthn_challenges`: purpose `register`, `second-factor`, `passwordless` or `confirm`) is bound to its account, session or, for passwordless sign-in, a `__Host-nu_webauthn` cookie (Strict, 5 minutes); it is used once, atomically, and void after 5 minutes; a new one voids the earlier one of the same purpose and binding. Registration needs a recent sign-in, a discoverable key and user verification (attestation `none`), and the first factor also creates recovery codes. As a second factor, user verification is `preferred` and the try limits are those of authenticator codes. **Passwordless sign-in** requires user verification, finds the account by credential id and checks the user handle; it counts as both steps (active session, new token, recent sign-in). Any failure gets the same 401 as a wrong password, counts in the per-IP sign-in limits (T11) and is audited as `sign-in.failed` (method `passkey`, with its reason). When the stored signature counter is above 0, a counter that doesn't increase is refused and audited as `second-factor.failed` (reason `counter`). A pending session can only add a passkey through the enrolment routes while it has no factor, and only the session that enrolled it can acknowledge its recovery codes. | Integration tests with a software ES256 authenticator; Playwright with a CDP virtual authenticator. | Passkeys |

## T11. Rate limiting

All limits are configurable settings with these defaults. IPs come from
Fastify's `request.ip` with `trustProxy` set to `TRUSTED_PROXIES` only (see
[deployment.md](deployment.md#tls-and-the-reverse-proxy)). IPv6 addresses are
grouped by /64. A rejected request gets `429` with `Retry-After`.

| Limit | Key | Default | Store | Owner |
|---|---|---|---|---|
| Global API | IP | 600 requests / minute | memory (`@fastify/rate-limit`) | Skeleton |
| Sign-in attempts | IP | 10 / minute, 50 / hour | memory | Accounts |
| Sign-in failures | subject + IP | after 5 failures, delay starts at 1 s and doubles up to 60 s. Password proofs for one subject run one at a time (in-process lock), so a burst of parallel attempts is counted one by one. | DB (`sign_in_failures`) | Accounts |
| Sign-in lock | subject | 20 failures in an hour across all IPs lock the subject 15 minutes. **No permanent lockout**, so nobody can lock an account out for good. Password proofs for one subject run one at a time (in-process lock), so a burst of parallel attempts is counted one by one. | DB (`sign_in_locks`) | Accounts |
| Second factor | session / account | 5 / 15 minutes per session, 10 / hour per account (T10). Second-step tries of one account run one at a time. | DB (`second_factor_failures`; rows older than an hour are swept) | 2FA |
| Invitation / re-link page (the four public routes; setting `linkPageRateLimit`) | IP | 20 / minute | memory | Invitations |
| Share links (setting `shareLinkLimits`) | IP / link | see T8 | memory (counters) + DB (`share_links.locked_until`) | Share links |
| Uploads | user | see T7 | DB (in progress) + memory (per hour) | Files |
| Allowing a folder (T16) | account | 5 requests / 15 minutes, whatever they end in; the password and second factor also count in the sign-in and second-factor limits above | memory | Allow folders |
| argon2id hashing | process | 4 in parallel; the rest queue for at most 5 s, then 503 | memory | Accounts |

Memory stores are enough because the app runs as one process. The subject of a
sign-in delay or lock is the account when the identifier names one, and
otherwise the identifier's keyed hash (T1), so unknown identifiers are limited
exactly like accounts. These counters persist in the database, so a restart
does not reset them; a daily job deletes the rows whose window, delay and lock
are over, so unknown identifiers can't grow the tables for good. A lock and a rate-limit hit are recorded in the audit log only; no email is sent for them. The SSO start on those pages also counts against the sign-in limits. Unknown, wrong-password, disabled and
no-password accounts get the same 401 and similar timing (T1).

## T12. The audit log

| Mitigation | Test | Owner |
|---|---|---|
| An append-only table. The app has no update route and no delete route, other than the retention purge. The UI is read-only, with filters (time, actor, action, outcome) and CSV export. | Contract test. | Accounts (module), each feature Task for its own events |
| **Recorded for each event**: time, actor kind (`account`, `share-link`, `anonymous`, `system`) and id, action, target kind and id, outcome (`succeeded`/`failed`/`denied`), IP, user agent (first 256 characters), and details as JSON. **Never recorded**: passwords, codes, tokens, secrets, file contents. Paths are recorded. | Unit test: details schemas per action have no secret fields. | each owner |
| **Events** (at least): `setup-link.issued`, `setup.completed`, `account.created` / `.enabled` / `.disabled` / `.deleted` (with the home choice), `sign-in.succeeded` / `.failed` / `.locked`, `sign-out`, `session.revoked`, `second-factor.added` / `.removed` / `.failed` / `.recovery-code-used`, `password.changed`, `invitation.created` / `.resent` / `.accepted` / `.revoked`, `relink.created` / `.used`, `linked-sign-in.added` / `.removed`, `sso-provider.changed`, `settings.changed` (which keys, not secret values; mail and the default quota included), `mail.test-sent`, `resource.added` / `.changed` / `.removed` / `.mount-failed`, `folder.allowed` (T16), `home-root.changed`, `file.uploaded` / `.deleted`, `share-link.created` / `.changed` / `.revoked` / `.downloaded` / `.password-failed` / `.locked`, `rate-limit.triggered` (once per key per window), `system.started` / `.migrated` / `.key-rotated`. File downloads by the admin and by users are not recorded (too noisy); share-link downloads are. | Integration test per event in its owner Task. | each owner |
| **Retention**: 365 days by default (setting, 30–3650). A daily job (the `platform` scheduler) purges older events and records `audit.purged` with the count. | Clock-injected test. | Accounts |
| Events are also written to the log (journald) as JSON, so an attacker with admin access to the app cannot remove the copy on the host. | Test that `record()` logs. | Accounts |

## T13. Security headers and supply chain

**Headers** (through `@fastify/helmet`, on every response): the CSP from T4;
`Strict-Transport-Security: max-age=31536000` (`includeSubDomains` only when
`HSTS_INCLUDE_SUBDOMAINS=true`); `X-Content-Type-Options: nosniff`;
`Referrer-Policy: no-referrer`; `Cross-Origin-Opener-Policy: same-origin`;
`Cross-Origin-Resource-Policy: same-origin`; `X-Frame-Options: DENY`;
`Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), publickey-credentials-get=(self), publickey-credentials-create=(self)`;
`Cache-Control: no-store` on every `/api` response, file downloads included. `Server` and `X-Powered-By` are not sent.
Owner: **Skeleton**; test: a header snapshot test over one route of each kind.

**Supply chain** (owner **Skeleton**, checked by **Review**):

- `pnpm-lock.yaml` committed; CI installs with `--frozen-lockfile`.
- pnpm's lifecycle scripts are off by default; `allowBuilds` in
  `pnpm-workspace.yaml` allows exactly `better-sqlite3` (and `strictDepBuilds`
  fails the install on any other script), whose install script fetches its prebuilt
  binary (or compiles it where none exists). @node-rs/argon2 needs no script:
  its binaries come as optional dependencies.
- `minimumReleaseAge: 4320` (3 days) in `pnpm-workspace.yaml`, so a freshly
  hijacked release is not picked up the day it is published.
- Few dependencies: each new runtime dependency is named in the Task that adds
  it, with why.
- CI runs `pnpm audit --prod --audit-level=high` and fails on findings.
  Renovate opens grouped weekly updates; security updates come at once.
- **Releases** (owner **Install**; see
  [stack.md](stack.md#release-artefact)). semantic-release decides each
  version from the commits on `main`; its job alone may push the tag and open
  the draft GitHub Release, and the job that publishes it alone may attach
  files (`contents: write`); the builds read only. The workflow Release builds each
  tarball from the lockfile alone: `pnpm install --frozen-lockfile` with no
  pnpm store cache, so a poisoned cache can't reach a release. Each tarball
  carries a CycloneDX SBOM of what it ships (`release/`), made by
  `@cyclonedx/cdxgen` pinned to 12.9.3, which is also attached beside it.
  `SHA256SUMS` covers the tarballs only; the attached SBOMs are taken out of
  them, so the copy inside a verified tarball is the one to trust.
- **What verifies a release:** `SHA256SUMS.sig`, an Ed25519 signature over
  `SHA256SUMS`, made in the `sign` job with a key only the protected
  `release-signing` environment holds (or, in an emergency, the offline backup
  key), and checked with keys pinned in the installed release or in the
  one-line installer; then `SHA256SUMS` itself, before unpacking. The one-line
  installer (`install.sh` on the Release, from
  `scripts/release/bootstrap-install.sh`) stops on a missing or failing
  signature and on a checksum mismatch; by hand it is `openssl pkeyutl
  -verify` and `sha256sum --check`
  ([docs/install.md](../install.md#download-and-verify-by-hand)); the update
  helper checks both, and more (T17). Whoever can change the GitHub Release
  but holds no signing key can no longer get a tarball installed. They can
  still change the one-line installer itself, which no installer can catch:
  that is why docs/install.md shows how to check `install.sh` against the
  signed `SHA256SUMS` by hand (RR-9). Key handling is in
  [deployment.md, "Release signing"](deployment.md#release-signing).
- **Node from NodeSource.** When the host has no Node, `install.sh` adds
  NodeSource's apt or dnf repository for Node 24 (apt checks the signed
  repository; dnf checks each package's signature, `gpgcheck=1`, but not the
  repository metadata, `repo_gpgcheck=0`). NodeSource's signing keys are
  vendored in the tarball (`deploy/keys/`), so they are covered by
  `SHA256SUMS` and nothing is fetched to decide what to trust. The apt pin and
  the dnf priority make NodeSource's `nodejs` win over the distribution's. The
  installer refuses a `/usr/bin/node` of another major or older than 24.11.
- cdxgen is pinned by version and the install tests' images (Samba, Debian,
  Fedora) by tag. The GitHub Actions in both workflows are referenced by
  major version tag (`@v5`, `@v4`), not by commit.

## T14. The local OS attacker and the mount helper

| Mitigation | Test | Owner |
|---|---|---|
| The service runs as the system user `not-unreachable` (made by `systemd-sysusers`: shell `/usr/sbin/nologin`, home `/`, password locked) with the systemd hardening in [deployment.md](deployment.md#systemd-unit). The backup unit and the CLI's service-user commands run with the same sandbox. Its data directory is `0700`; config `0640 root:not-unreachable`; the release in `/opt` belongs to root and is writable by nobody else; the master key (`root:root 0600`) is reachable only through `LoadCredential=`. The CLI wrapper runs only as root. `rotate-key` also refuses unless `fs.protected_hardlinks` is 1, as it gives files back with `chown` as root inside the service user's folder. | The install script fails if `systemd-analyze security not-unreachable.service` scores the running service above 2.0, and its mode audit fails on any path whose owner or mode differs from [deployment.md](deployment.md#config-secrets-and-data), on anything in the release not owned by root or writable by group or others, and on a service user with a shell or an unlocked password. `deploy/install/` checks the exposure offline, the layout against the table, and the backup unit's and wrapper's sandbox against the service unit, and that `rotate-key` refuses while `fs.protected_hardlinks` is off. | Install |
| The service listens on `127.0.0.1:8480` by default, never on `0.0.0.0` unless configured. | Config test. | Skeleton |
| The mount helper is the only root code the service can start, apart from the folder helper while `ALLOW_FOLDERS_FROM_UI` is on (T16) and the update helper's verify unit while `UPDATE_FROM_UI` is on (T17). (The CLI commands `allow-folder`, `allow-folders-from-ui`, `update-from-ui`, `update-recover` and `rotate-key` also run as root, but only root can run the CLI.) Polkit lets the service user start and stop **only** `not-unreachable-mount@<lower-case UUID>.service` (no restart). The helper validates the share id as a UUID, opens its request from a path it derives itself with `O_NOFOLLOW`, through the request directory it opened once with `O_NOFOLLOW` (`/proc/self/fd/<n>/`, so a directory swapped for a symlink is never followed), and checks the descriptor (regular file, owner, mode, size), validates every field against strict patterns, and sets every mount option itself. It **never writes into a directory the service user controls**: the result is its exit code, and mount points are under the root-owned `/srv/not-unreachable/mounts` (see [smb.md](smb.md#what-happens-underneath)). | Helper tests as root with hostile requests: option injection like `host,uid=0`, `../` in the share name, a symlinked or swapped request file, a symlinked request directory, a FIFO, a file owned by another user. Polkit rule test: other units, other verbs (`restart`) and instances that aren't a UUID fall through. | Resources, Install |
| An SMB server on a hostile LAN: SMB 3.1.1 by default; signing (`sign`) is always required; encryption (`seal`) is on by default, and the UI warns wherever it is off. With it on, file contents and credentials are not in clear text on the wire. SMB 3.0 and 2.1 are offered only for older servers, and only when the admin picks them. | Helper test of the options per protocol choice. | Resources |

## T15. Open redirects, Host header and SSRF

| Mitigation | Test | Owner |
|---|---|---|
| Every absolute URL the app makes (invitation links, emails, SSO redirect URIs, passkey origin) comes from `PUBLIC_ORIGIN`, never from the `Host` or `X-Forwarded-Host` header. | Test with a forged `Host`. | Skeleton |
| After sign-in, `?next=` is accepted only as a relative path starting with a single `/` and matching a known SPA route. | Unit test with `//evil`, `/\evil`, `https:`. | Accounts |
| SSO issuer URLs and SMB hosts are entered by the admin only. Issuers must be `https://`. The server fetches nothing else on anyone's behalf. The update check and download (T17) go only to fixed GitHub URLs built from a validated version, never to a URL from a request or from GitHub's answer, and follow redirects only to a fixed list of GitHub hosts. | Validation tests; update download tests with a redirect off the list. | SSO, Resources, Updates |

## T16. Allowing folders from the admin interface

With `ALLOW_FOLDERS_FROM_UI=true`, the admin can add a local folder to the
`resources.conf` drop-in (the asset "Where the service may write") from **Add
resource → Local folder**, instead of running `sudo not-unreachable
allow-folder` on the server. A root helper does the writing (see
[deployment.md](deployment.md#allowing-folders-from-the-admin-interface)).
Off, the default, nothing below is reachable. Who can reach it while on: an
admin session that also proves the password and a second factor on that
request, and the service user, only by starting one unit through polkit.

| Mitigation | Test | Owner |
|---|---|---|
| **Off by default, and off means unreachable.** A new install writes `ALLOW_FOLDERS_FROM_UI=false`; an upgrade keeps the config, so it never turns it on. Only root switches it, with `not-unreachable allow-folders-from-ui on\|off`. Off: the route is not registered (404), the polkit rule `51-not-unreachable-allow-folder.rules` is not in `/etc/polkit-1/rules.d` (removed first when switching off; every install syncs it with the switch), and the helper itself refuses (exit 6). | Config test (default false); route test (404 when off); install tests: no rule on a new install or an upgrade, the rule follows the switch on every run; helper test with the switch off. | Allow folders, Install |
| **The polkit rule** lets the service user `start` exactly `not-unreachable-allow-folder.service`: no other unit, no other verb. | Polkit rule test: other units and verbs fall through. | Allow folders |
| **A fresh proof of both factors on every request.** `POST /api/v1/admin/resources/allowed-folders` is admin only and needs the password and an authenticator code or passkey answer in the request (`SignInService.reauthenticate`); a recent sign-in is not enough, and a stolen session token alone gets nothing. Both are checked as at sign-in, under the same try limits (T10, T11); the second factor only once the password passed. Plus 5 requests per account per 15 minutes. The path is looked at only after both factors passed. | Integration tests: no proof, wrong password, wrong code, the limit, success. | Allow folders |
| **The helper trusts only root's files.** It reads the switch, `ALLOWED_FOLDER_PREFIXES` and `DATA_DIR` from `config.env` itself, refusing it unless it is root's regular file not writable by group or others, never from the request. The request file (`/run/not-unreachable/folder-requests/allow-folder.json`, service user, `0600`, under 8 KiB) is read as the mount helper reads its own: `O_NOFOLLOW` through the pinned directory, checks on the descriptor, strict JSON. | Helper tests with hostile requests: a symlinked or swapped request or directory, a FIFO, another owner, a wrong mode, an oversize or malformed file; a group-writable or non-root config. | Allow folders |
| **The path checks**, on the real path after resolving symlinks, in the helper (and before it in the server, for clear messages): absolute; exists and is a folder; only characters a drop-in can list; not a system folder (`/bin`, `/boot`, `/dev`, `/etc`, `/lib*`, `/opt`, `/proc`, `/root`, `/run`, `/sbin`, `/snap`, `/sys`, `/tmp`, `/usr`, `/var`), nor inside or holding one, so never `/`; inside one of `ALLOWED_FOLDER_PREFIXES` (default `/srv,/mnt`; each prefix must itself pass the system-folder rule, or the server and the helper refuse the config); neither inside nor holding `DATA_DIR`, `/opt/not-unreachable` or `/srv/not-unreachable/mounts`; and, in the helper only, neither inside nor holding a folder `resources.conf` lists already (as written or by its real path): the service writes in those, so it could swap a folder below one for a symlink that systemd follows at the next start. | Helper and server tests: accepted paths, a symlink under a prefix pointing outside it, each system folder, `/`, each forbidden root, bad prefixes; helper tests for a folder inside or holding a listed one, also once that one was swapped for a symlink. | Allow folders |
| **The helper's sandbox.** Root with `CAP_DAC_READ_SEARCH` only, `ProtectSystem=strict` with the drop-in folder its one writable path, `PrivateNetwork=`, `RestrictAddressFamilies=AF_UNIX`, `SystemCallFilter=@system-service ~@privileged @mount`. It writes `resources.conf` with the same code as `allow-folder`, runs only `systemctl daemon-reload` and `systemd-run … systemctl restart not-unreachable.service` (3 s later, so the server answers and audits first) through `execFile`, and reports by exit code. | The install fails above exposure 1.5 for its unit; `deploy/install/` checks it offline. | Allow folders, Install |
| **Audit and notice.** Every request records one `folder.allowed` (path, real path, result; `succeeded`, `failed` or `denied`); a failed proof also records the usual `sign-in.failed` or `second-factor.failed`. A success emails the admin a security notice (T10). Problem bodies and logs never hold the path. | Integration tests per outcome, the notice mail included. | Allow folders |

**What's left.** While the switch is on, an attacker with the admin's
password and second factor (or code running as the server process) can make
the service writable in any folder inside `ALLOWED_FOLDER_PREFIXES` that isn't
one of the service's own: nothing outside them, and never a system folder.
With the switch off, this is as before: only root on the host adds folders
(RR-7).

## T17. Updating from Settings and release signing

The admin sees in **Settings → Updates** whether a newer release is out, and
with `UPDATE_FROM_UI=true` installs it from there, instead of running the
one-line installer over SSH. An offline root helper verifies the release and a
second root unit installs it, restarts the service and rolls back on a failed
start (see [deployment.md, "Updating from
Settings"](deployment.md#updating-from-settings) and ["Release
signing"](deployment.md#release-signing)). What it adds: an outbound request to
GitHub, a new path to root, and the signing keys as an asset. Who can reach
the path to root while the switch is on: an admin session that also proves the
password and a second factor on that request, and the service user, only by
starting one unit through polkit.

| Mitigation | Test | Owner |
|---|---|---|
| **Off by default, and off means unreachable.** A new install writes `UPDATE_FROM_UI=false`; an upgrade, from Settings too, keeps the config, so it never turns it on. Only root switches it, with `not-unreachable update-from-ui on\|off`. Off: the install route is not registered (404), the polkit rule `52-not-unreachable-update.rules` is not in `/etc/polkit-1/rules.d` (removed first when switching off; every install syncs it with the switch), and both units refuse (`switch-off`). | Config test (default false); route test (404 when off); install tests: no rule on a new install or an upgrade, the rule follows the switch on every run; helper tests with the switch off, for both units. | Updates, Install |
| **The polkit rule** lets the service user `start` exactly `not-unreachable-update.service`: no other unit, no other verb. Nothing lets it start the apply unit. | Polkit rule test: other units (the apply unit among them) and verbs fall through. | Updates |
| **A fresh proof of both factors on every install.** `POST /api/v1/admin/updates/install` is admin only and needs the password and an authenticator code or passkey answer in the request; a recent sign-in is not enough, and a stolen session token alone gets nothing. Both are checked as at sign-in, under the same try limits (T10, T11); the second only once the password passed. Plus 5 requests per account per 15 minutes, and one update at a time. **Check now** is limited to once a minute and 10 times an hour for the instance. | Integration tests: no proof, wrong password, wrong code, the limit, an update in progress, a version that isn't the latest installable one, success. | Updates |
| **A compromised server process can't install anything unsigned, older or the same.** It controls the spool and the request, so the helper trusts neither: the request holds only a request id and a version, strictly checked; the helper derives every path itself, takes the architecture from its own process, and reads its rules from root's `config.env`. It opens each spool file through the pinned spool folder with `O_NOFOLLOW`, checks owner, type and size on the descriptor, and copies it into a root-only folder before checking anything, counting bytes against the cap, so a swap after a check, a symlink, a FIFO or an endless file gets nowhere. The worst it can do is start an upgrade to the newest genuine signed release, without the admin; that restarts the service, and each new release can be installed once. | Helper tests as root with hostile requests and spools: a symlinked or swapped request, spool file or folder, a FIFO, another owner, a wrong mode, an oversize or growing file, a file swapped after the copy; a group-writable or non-root config. | Updates |
| **A tampered GitHub asset is refused.** The helper verifies `SHA256SUMS.sig` with the keys pinned in the release `current` points to (a root-owned folder in `/opt`), never with a key from the download; then the tarball's SHA-256 against the signed line for its own name. Missing, malformed or failing signatures, an unknown key id, or a tarball, `SHA256SUMS` or signature changed by one byte are all refused before anything is unpacked. The server checks the same first, only to fail early. The one-line installer checks the signature with `openssl` and its inline keys before reading `SHA256SUMS`. | Helper and server tests with a valid release, then one byte changed in each file, a signature by an unpinned key, a signature line for a pinned key that fails beside one that verifies, no signature file, a malformed one. Bootstrap tests: a missing, failing or malformed signature stops it; its inline keys equal `deploy/keys/release-signing/`. | Updates, Install |
| **No downgrade, no replay.** The version must be the same in the request, the signed `SHA256SUMS` line's file name and the tarball's own `VERSION` (and the architecture in its `ARCH`), and newer than `current` by SemVer 2.0 precedence: an older signed release, or the one installed now, is refused. The server offers only the latest installable release, and the route refuses any other version. | Helper tests: an older and the same signed release, a tarball whose `VERSION` or `ARCH` differs from its signed name, a request for a version other than the spool's; route test with an older version. | Updates |
| **An unsafe archive is refused.** The helper reads the tar itself (no `tar` binary): only gzip with ustar and pax headers; one top folder; no absolute name, `..` or empty component, NUL, hard link, device, FIFO, socket, setuid, setgid or sticky bit, or duplicate name; symlinks only under `release/node_modules/` and only to a relative target inside `release/`; at most 1 GiB unpacked and 200 000 entries. It checks every entry before writing any, then unpacks with `O_EXCL` and `O_NOFOLLOW`, as root, with fixed modes. These hold even for a signed release, as a second line. | Archive tests with each unsafe entry, a link out of `release/`, a truncated and a corrupt archive, a zip bomb past the caps, and the real release tarball. | Updates |
| **The verify unit has no network and almost no rights.** Everything the server could have shaped is read there: root with `CAP_DAC_READ_SEARCH` only, `PrivateNetwork=`, `IPAddressDeny=any`, `RestrictAddressFamilies=AF_UNIX`, `ProtectSystem=strict` with its state folder its only writable path, `SystemCallFilter=@system-service ~@privileged @mount`. The apply unit, which has an upgrade's rights, reads only root's own files in the root-only work folder, reaches loopback only (the health check), and has no polkit rule. | The install fails above exposure 1.5 for the verify unit and 3.0 for the apply unit; `deploy/install/` checks both offline, and that the verify unit has `PrivateNetwork=yes` and `IPAddressDeny=any`. | Updates, Install |
| **One update at a time.** A lock file created with `O_EXCL` in the root-only work folder covers both units; systemd never runs a unit twice at once; the server refuses a second request while one is in progress or the status file says so. | Helper tests: a second verify while the apply unit runs (`busy`), a stale lock after a stop before anything changed (cleared), a stale lock after a stop half-way (`interrupted`). | Updates |
| **A host is never left half-updated without a way back.** The installer checks everything that could stop it (the host, Node, the service user) before changing anything, and exits 3 when it can't go on offline; its file changes are each atomic. The status file records each phase before it starts. A new release that doesn't become ready, crashes within 30 seconds, or doesn't answer `/api/v1/health` is rolled back: the service is stopped, the database restored from the pre-migration backup this start made (before any old code runs on it), the previous release's own kept installer puts its system files back and switches `current`, and the old release is started and checked the same way. A power cut or a killed unit leaves the status in progress: the helper then refuses new updates (`interrupted`), Settings and the helper's refusal name `sudo not-unreachable update-recover`, which runs the same rollback from wherever it stopped, and any install over SSH ends it too. If the old release can't come back either (`rollback-failed`), the service stays down rather than run old code on a migrated database, and the admin follows docs/install.md. | Apply tests (as root, in the install test containers): a release that fails to start, one that crashes after starting, one that migrates then fails (the database equals the backup afterwards), an installer that fails half-way, a stop at each phase then `update-recover`; each ends on the old release with its system files, as the mode audit lists them. | Updates, Install |
| **The update check sends nothing that identifies the instance**, and can be turned off. It is one fixed `GET` to the GitHub API with fixed headers, no token, cookie, version, origin or query; answers are capped, validated and cached for 6 hours. `UPDATE_CHECK=false` makes the server ask GitHub nothing at all. GitHub still sees the host's address and the time (RR-10). | Test of the exact request (URL, headers, no body); config test (`UPDATE_CHECK=false`: no request, check route 404); tests with an oversize, malformed or redirecting answer. | Updates |
| **Lost or leaked signing keys.** The active key is a secret of the `release-signing` environment (the `main` branch only, an approval for each run), used only in the `sign` job, which can't write to the repository; `publish`, which can, never sees it. A backup key, kept offline, is pinned in every release beside it. Lost: the backup signs the next release, which pins a new backup. Leaked: the same, at once, with a security advisory; until a host updates, the leaked key alone still isn't enough, as the attacker must also serve files at this repository's Release URLs (RR-8). Planned rotations sign with both the old and new active key for 12 months. The `sign` job references its Actions by commit SHA, not by tag (unlike the rest, R-D3), as it is the one job that holds the key. | A test that reads `release.yml`: only `sign` names the environment and its secrets, its Actions are pinned by SHA, and `publish` has no secret; `sign-checksums.ts` tests: it refuses to sign with a key that isn't pinned, and its output verifies. | Updates |
| **Audit and notice.** Every install request records `update.requested` (`accepted`, `denied` or `refused`); a failed proof also records `sign-in.failed` or `second-factor.failed`. Each accepted request records one `update.finished` with its result and reason, written by whichever server sees the final status first. A success emails the admin a security notice, a rollback an alert (T10). Problem bodies and logs hold versions and reasons only. | Integration tests per outcome, the mails included; a test that a restart after a rollback records `update.finished` once. | Updates |

**What's left.** While the switch is on, an attacker with the admin's password
and second factor, or code running as the server process, can install the
newest genuine signed release: nothing unsigned, nothing older, nothing
twice. An attacker who holds a signing key *and* can change this repository's
GitHub Releases can get code installed on every host whose admin updates,
from Settings or over SSH, as before signing anyone with the second alone
could (RR-8). The one-line installer can't vouch for itself (RR-9).

## Residual risk register

What the threat model leaves open, on purpose or for later. The
[security review](../security/review.md) checked every row above and added the
R- entries: **accepted** risks were accepted with the design; **proposed** ones
the review proposes to accept, and the user accepts them when approving the
review; **open, needs a Task** ones need more work than the review could do.

| Id | Risk | Likelihood | Impact | Mitigation in place | Why accepted | Worth revisiting when | Status |
|---|---|---|---|---|---|---|---|
| RR-1 | A compromised admin account can read every resource. | low | high | The admin always needs a second factor (T10); short session timeouts; a recent sign-in for every sensitive change; every action is audited. | The admin is trusted and must reach every resource; that is the product. | More than one admin, or delegated admin roles. | accepted |
| RR-2 | Whoever holds the admin's password when the admin enrols for the first time (after setup, or after `reset-admin --second-factors`) can enrol first and keep the account. | low | high | Setup links are single use and live 1 hour; `reset-admin` needs the host's shell; enrolment answers 409 once a factor exists. | Setup links and the host shell are the only paths to that state. | A web path that removes the admin's factors. | accepted |
| RR-3 | Security notices (recovery code used, factor added or removed, lock) are emailed only once SMTP is set; before that they are audit only. | medium | low | Every notice is audited. | An instance without SMTP has no other channel to the admin. | A notice channel other than email. | accepted |
| RR-4 | Hard links placed in a resource by a local OS user can point outside it (T5). | low | high | No route creates links; the installer and [install.md](../install.md#install) say to map only folders other OS users cannot write to. | Only shell access can make one, and nothing can tell a planted link from a real file. | Hosts shared with untrusted OS users becoming a supported use. | accepted |
| RR-5 | Memory rate-limit counters reset on restart (the per-account ones and share-link locks do not). | low | low | Sign-in delays and locks, second-factor tries and share-link locks are in the database. | One process; a restart needs host access or a crash. | A way to restart or crash the app on demand. | accepted |
| RR-6 | A reverse proxy not set up as the shipped examples (`deploy/proxy/`) may log share-link, invitation and re-link tokens and the SSO callback's code. | low | medium | The examples keep every URL that carries a token out of the access log, matched on the decoded path (tested); the app's own log cuts them out (T8). | The operator's proxy is outside the app's control. | A token found in a log of the shipped examples, or a new route with a token in its URL. | accepted |
| RR-7 | While `ALLOW_FOLDERS_FROM_UI` is on, whoever has the admin's password and second factor, or code running as the server process, can make the service writable in any folder inside `ALLOWED_FOLDER_PREFIXES` (T16). | low | high | Off by default and switched by root only; a fresh password and second factor on every request; 5 requests per 15 minutes; the root helper re-checks the real path against the prefixes, system folders and the service's own folders, and reads its rules only from root's `config.env`; polkit allows that one unit only while on; audited, with a notice mail. Nothing outside the prefixes, never a system folder. | Opt-in: the admin already reaches every resource (RR-1), and the prefixes bound what a stolen admin can add. | More than one admin, or prefixes wider than data folders. | accepted |
| RR-8 | Whoever holds a release signing key and can also change this repository's GitHub Releases can get their code installed as root on every host whose admin updates (T17). Both keys lost means no release reaches a host until each admin installs a new key set by hand. | low | high | The active key is in the protected `release-signing` environment (the `main` branch only, an approval per run), used only by the `sign` job, whose Actions are pinned by SHA; the backup key is offline; a lost or leaked active key is replaced by the backup with no host stranded; the helper and the installer download only from this repository's Release URLs. | Two independent controls (the key and the Releases) must both fail; any signing scheme ends at someone holding a key. | A key leak, a compromised Action or workflow, or more than one maintainer. | accepted |
| RR-9 | The one-line installer can't check itself: whoever can change a GitHub Release can replace `install.sh` with one that skips the signature, for anyone who pipes it to `sudo bash` without checking it first. | low | high | docs/install.md shows how to check `install.sh` against the signed `SHA256SUMS` with the published key ids before running it; installed hosts updating from Settings don't use it. | A download-and-run installer can't be its own root of trust. | Distribution packages (apt, dnf) with signed repositories. | accepted |
| RR-10 | GitHub sees each host's address and the times it checks for updates, and could hide newer releases from it (a freeze). | medium | low | No identifying data in the request; every 6 hours at most, cached; `UPDATE_CHECK=false` turns it off; a release GitHub hides is still listed in the repository and announced. | Learning about releases needs asking someone; GitHub already hosts the releases. | A mirror or a signed release feed. | accepted |
| RR-11 | The apply unit runs a signed release's installer as root with an upgrade's rights (exposure up to 3.0), so a bug in a signed installer runs as root. | low | high | The installer is the same code the admin would run over SSH, verified first by the offline verify unit; the apply unit has no polkit rule, reaches loopback only and reads only root's files. | Installing system files needs those rights, however it is started. | A way to install releases without writing system files. | accepted |
| RR-12 | An update interrupted by a power cut or a killed unit, or a rollback that fails, needs the admin on the server (`update-recover`, docs/install.md); until then the service may be down. | low | medium | Each phase is recorded before it starts; every rollback step can be run again; new updates are refused until it is recovered; Settings names the command when the service is up. | Recovering on its own at boot would need a root unit at every start for a rare case. | Reports of interrupted updates. | accepted |
| R-A1 | Users sign in with one factor (their SSO provider); the app neither requires nor checks the provider's MFA (`acr`, `amr`). | medium | medium | Users reach only their own home; the admin always needs a second factor; a disabled provider or account stops sign-in at once; 7-day absolute and 2-hour idle timeouts. | Documented design (T9 row 4, T10 row 2): users rely on their provider's MFA. | An IdP compromise trend, or users given access beyond their home. | proposed |
| R-A2 | No list of context-specific words (product name, username, email) refused in passwords (ASVS V6.1.2, V6.2.11). | low | low | Only the admin has a password: 12–256 characters, the breached list, argon2id, sign-in limits, always a second factor. | One password in the system, behind a second factor; a word list would change the password policy. | More accounts with passwords, or a policy update. | proposed |
| R-A3 | Concurrent sessions per account are unlimited (ASVS V7.1.2). | low | low | Settings → Sessions lists every session and signs out one or all; timeouts bound each (T2). | A cap adds little in a single-admin app. | A need to cap sessions. | proposed |
| R-A4 | Signing out another session needs no fresh sign-in (ASVS V7.5.2), and the admin ends a user's sessions only by disabling or re-linking them, not for all users at once (V7.4.5). | low | low | Revoking only ends sessions; every revocation is audited; disabling a user revokes all their sessions. | Revoking is safe: at worst a stolen session signs its owner out. | A request for an admin "sign out user / all users" action. | proposed |
| R-A5 | An SSO sign-in can't end the browser's earlier session: the Strict session cookie isn't sent on the provider's cross-site redirect, so the old session stays live, unreachable from that browser, until its timeout. | low | low | The new cookie replaces the old one in the browser; the old session times out and shows in Settings → Sessions. | No fixation: the server always issues a fresh token. | A way to carry the earlier session through the flow without weakening the Strict cookie. | proposed |
| R-B1 | The admin can set the home root to a folder inside a user's home (or a resource overlapping one that holds homes); new users' homes are then made inside that user's home, who can read them. | low | high | Only the admin sets the home root (recent sign-in, audited `home-root.changed`); NU-B1 stops the reverse case. | – | Home-root moves becoming common, or more than one admin. | open, needs a Task: `setHomeRoot` should refuse a path at or below a recorded home (real paths across resources) |
| R-B2 | When a folder of the chosen username is already in the home root, the invitee learns it only at the end of the SSO round trip, as a generic `accept-failed`, not `username-reserved`. | medium | low | NU-B1 refuses the takeover; no account or link is made. | – | Support requests about failed invitations. | open, needs a Task: the invitations module should also refuse a name whose folder exists |
| R-B3 | No antivirus scanning of uploads (ASVS V5.4.3). | medium | medium | Files are only served as inert attachments (octet-stream, `nosniff`, CSP sandbox); uploads need an account; only the admin makes share links. | A self-hosted personal file store; scanning needs an external engine and a quarantine flow. | Users sharing files with outsiders at scale, or hosting for third parties. | proposed |
| R-B4 | Uploaded content is not checked against its extension (ASVS V5.2.2). | high | low | The app makes no decision on file content and never renders it (T4 row 4). | Storing any file is the product's purpose. | A feature that previews, thumbnails or parses uploads. | proposed |
| R-B5 | Usernames may start with `.nu-upload-` or `.nu-write-check-`, so such a user's home is hidden from the admin's listing of the home root. | low | low | The home still works and is in the `homes` table; the admin can delete the user and home from Users. | – | Any other hidden-name convention. | open, needs a Task: refuse a leading `.` in usernames (a contracts change) |
| R-B6 | Expiry or revocation of a share link stops a download at its next request; a whole-file GET already streaming runs to its end. | medium | low | Every request and range request re-checks the link (tested); 4 downloads per link per IP. | As documented in T8. | Large files shared with untrusted recipients where instant cut-off matters. | proposed |
| R-B7 | The public share page shows the item's name, kind, size and expiry to anyone with the token, before the link password. | high | low | The token is 256-bit and rate limited; contents and listings need the unlock. | Design decision (T8). | A request to hide names of password-protected links. | proposed |
| R-C2 | HSTS `includeSubDomains` (ASVS V3.4.1) is off unless `HSTS_INCLUDE_SUBDOMAINS=true`. | low | low | `max-age=31536000` on every response; the operator turns it on when the parent domain is all HTTPS. | Forcing it could break the operator's other hosts (T13). | The instance on its own domain whose subdomains are all HTTPS. | proposed |
| R-C3 | The threat model said downloads get `Cache-Control: private, no-cache`; they get `no-store`, which is stricter. | low | low | `no-store` on every `/api` answer, downloads included (header tests). | – | A need for browser caching of large downloads. | closed: T13 now says `no-store` |
| R-C4 | tus-js-client keeps unfinished uploads' fingerprints (account id, resource id, folder and file name) in localStorage after sign-out; the invitation draft is in sessionStorage during the SSO round trip. | low | low | Entries are per account and go when an upload finishes or is cancelled; the draft goes on return; no tokens or contents. | Needed to resume uploads across reloads. | Shared or kiosk computers becoming a supported use. | proposed |
| R-C5 | Share-link, invitation and re-link tokens are bearer tokens in URL paths (ASVS V14.2.1). | medium | medium | The app log cuts them out (NU-C1); `Referrer-Policy: no-referrer`; the proxy examples keep them out of the access log (NU-Z1). | Download managers and email links need plain URLs (T8, "Rejected"). | Evidence of tokens leaking through proxy logs or browser history. | proposed |
| R-C6 | No standalone crypto inventory or key-management policy (ASVS V11.1.1, V11.1.2), data classification by protection level (V14.1.1, V14.1.2) or log inventory with retention and access (V16.1.1). | low | low | The content exists across this document (Assets, T2, T6, T12) and [stack.md](stack.md) (Logging). | – | An ASVS certification or an external audit. | open, needs a Task (documentation only) |
| R-C7 | Logs are not shipped to a separate system (ASVS V16.4.3): root on the host can erase journald and the audit table. | low | medium | The admin in the app can't edit the journald copy (T12); there is no audit update or delete route. | A single-host self-hosted product; forwarding is the operator's choice. | Multi-host deployments, or a need for tamper-evident logs. | proposed |
| R-D1 | The mount helper's unit (root) scores 5.9 MEDIUM in `systemd-analyze security`: no namespacing (by design: the mount must reach the host), no `SystemCallFilter=`, no `UMask=`, `RestrictSUIDSGID=`, `ProtectClock=` and `ProtectHostname=` off. | low | high | Only fixed helper code runs; the id is checked as a UUID; the request is read through a pinned `O_NOFOLLOW` descriptor and every field is pattern-checked; `NoNewPrivileges=`, a cut capability set, `RestrictAddressFamilies=`, `RestrictNamespaces=`. | – | Any change to the helper's code or its input. | open, needs a Task: try `SystemCallFilter=@system-service @mount`, `UMask=0077`, `RestrictSUIDSGID=yes`, `ProtectClock=yes`, `ProtectHostname=yes` with the propagation test |
| R-D2 | esbuild 0.18.20 (GHSA-67mh-4wv8-2f99, 5.3 Medium: its dev server answers any origin) is in the lockfile, through drizzle-kit › @esbuild-kit. | low | low | Dev only: not in the release (`pnpm audit --prod` is clean; the tarball has no esbuild); its serve mode is never used. | Dev only, and drizzle-kit pins it. | drizzle-kit dropping @esbuild-kit, or esbuild in a production tree. | proposed |
| R-D3 | GitHub Actions are referenced by major tag, not commit; `pnpm dlx @cyclonedx/cdxgen@12.9.3` resolves cdxgen's own dependencies outside the lockfile at release time. | low | high | Workflow permissions `contents: read` (publish job `contents: write` only), `persist-credentials: false`, no cache in Release, `minimumReleaseAge`, `SHA256SUMS`. | As documented in T13 (last bullet). | A compromise of a referenced Action or a cdxgen dependency: then pin Actions by SHA. | proposed |
| R-D4 | The polkit rule matches by unit name; a `StartTransientUnit` call for `not-unreachable-mount@<uuid>.service` is stopped only because systemd refuses a transient unit whose name has a fragment file (the installed template). | low | high | systemd 252 asks polkit without unit details for transient units, so the rule falls through (tested); uninstall removes the rule with the template. | Depends on systemd behaviour that holds on supported versions. | A systemd version that passes unit details for transient units while the template is missing. | proposed |
| R-D5 | No documented remediation time frames per severity for vulnerable dependencies (ASVS V15.1.1). | medium | medium | Renovate security updates at once, with no release-age delay; CI fails on High or Critical in `pnpm audit --prod`. | – | A published advisory against a production dependency. | open, needs a Task (docs): for example "Critical or High in a production dependency: a fixed release within 7 days; Medium: the next weekly update; Low or dev only: the next update" in [stack.md](stack.md) |
| R-D6 | Reverse proxy to app traffic is plain HTTP on 127.0.0.1 (ASVS V12.3.1, V12.3.3). | low | medium | Loopback only by default (T14); `X-Forwarded-*` believed only from `TRUSTED_PROXIES`; plain HTTP from elsewhere answers 400 `https-required`. | Same host: no network path. | Running the proxy on another host. | proposed |
| R-D7 | Outbound destinations (SMB hosts, SSO issuers, the SMTP host) are an admin-entered list, not enforced by a network allowlist (ASVS V13.2.4, V13.2.5). | low | medium | Only the admin enters them (T15); issuers https only; a saved secret goes only to the host or issuer it was saved for (T6); `RestrictAddressFamilies=`. | The destinations are arbitrary LAN and Internet hosts by design. | A feature that fetches a URL a non-admin provides. | proposed |
| R-D8 | `rotate-key` still gives files back with a path-based `chown -h` as root inside the service user's folder; safe only while `fs.protected_hardlinks` is 1, which it now checks first (NU-D1). | low | high | `protected_hardlinks` is on by default on every supported distribution and now required; `chown -h` never follows symlinks; `find -xdev`. | Safe under the check it now makes. | A fix moving the `chown` into the CLI itself (open with `O_NOFOLLOW`, check one link, `fchown`). | proposed |
