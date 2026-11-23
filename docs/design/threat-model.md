# Threat model

NotUnreachable is exposed to the Internet and holds the admin's files, so
security comes first. Each threat below gives its mitigation in enough detail to
test, and the Task that owns it. The [Security review](#owners) Task checks the
whole list against the built app and OWASP ASVS 5.0 level 2.

## Owners

| Key | Task |
|---|---|
| **Skeleton** | Project skeleton: monorepo, API and web shell, database, security baseline, CI (Task 94776ed7-0244-4ba0-bd52-a6cfbac33271) |
| **Accounts** | Local accounts and sessions with separate admin and user interfaces (Task cff653c2-aafd-4202-bf5d-1e78458708a8) |
| **Invitations** | Invitations and user management (Task 4723ccf9-fc28-4532-a186-8f099f09903e) |
| **2FA** | Two-factor authentication: authenticator app, email codes, recovery codes (Task 378c8142-5b80-4646-bd76-3455d34a1da1) |
| **Passkeys** | Passkeys (Task 520bfe57-4e16-448c-87ba-916a6e9ace9e) |
| **Resources** | Mapped resources: local folders, SMB shares and the home root (Task 397cb6b6-e258-4e8d-8143-3ac08e74230a) |
| **SSO** | Single sign-on with Google, GitHub and OIDC (Task 7bd5a230-b9f0-4679-aac9-fbc0909fe528) |
| **Files** | Files: browse, chunked uploads, resumable downloads, delete (Task 65765533-4396-4ae9-a6da-6780c2b84a29) |
| **Share links** | Share links: public, password-protected, with expiry (Task ccb26ec8-a7f9-46fa-8d98-c9f55fa4d4a1) |
| **Install** | Linux install script (Task 1e20d309-2836-46ce-be58-757b7307d1f2) |
| **Review** | Security review of the whole app, with fixes (Task f1f3aa6d-0023-4448-bbe0-cefb832cb17b) |

## Assets

| Asset | Why it matters |
|---|---|
| Files in resources and homes | The reason the app exists; disclosure, tampering or deletion is the worst outcome. |
| The admin account | Full control of every resource, user and share link. |
| User accounts | Access to their home; a foothold for upload abuse. |
| SMB credentials | Often a Windows/NAS account with rights far beyond the mapped share. |
| The master key | Decrypts every secret in the database. |
| Session tokens, share-link tokens, invitation and reset tokens | Each is a bearer credential. |
| TOTP secrets, recovery codes, passkey public keys | Second factors. |
| SMTP and SSO client secrets | Let an attacker send mail as the instance or impersonate it to the IdP. |
| The audit log | Evidence after an incident; must be complete and not editable from the app. |
| The host | The app must not become a way into the server or the LAN. |

## Trust boundaries

```
 Internet ──TLS──▶ reverse proxy ──HTTP (loopback)──▶ not-unreachable (service user)
                                                     │        │            │
                                         SQLite + data dir   local folders  /srv/not-unreachable/mounts/* (cifs)
                                                     │                          ▲
                                                     └── D-Bus (polkit) ──▶ mount helper (root, one oneshot unit per share)
                                                                                │
                                                                         SMB server on the LAN
```

1. **Internet ↔ reverse proxy**: everything outside is untrusted. TLS ends here.
2. **Reverse proxy ↔ app**: the app trusts `X-Forwarded-*` only from the
   addresses in `TRUSTED_PROXIES` (see [deployment.md](deployment.md#tls-and-the-reverse-proxy)).
3. **App ↔ file system**: the app is trusted to stay inside its resources; the
   path-safety layer is the boundary.
4. **App ↔ mount helper**: the only path to root. The helper trusts nothing the
   app sends beyond a share id and a strictly validated request (see [smb.md](smb.md)).
5. **App ↔ IdPs and SMTP**: outbound TLS; responses are validated, never trusted.

## Attackers

| Attacker | Can | Wants |
|---|---|---|
| **Anonymous Internet** | Reach every public route: sign-in, invitation and reset pages, the share page, static assets. Automated scanners and credential stuffing. | Any account, files, a shell. |
| **Invited user** | Everything a user may do, with a valid session. Can upload arbitrary bytes and names. | Other homes, resources, the admin role, disk exhaustion, XSS against the admin. |
| **Holder of a share link** | Open that link's file or folder; guess passwords; reuse a leaked or expired link. | More than the link covers; other links. |
| **Network attacker** | Watch or change traffic between client and proxy, or proxy and SMB server on a hostile LAN. | Tokens, file contents, SMB credentials. |
| **Local OS user** (another account on the host) | Read world-readable files, see process lists, use local sockets. | The database, the master key, the mounts. |
| **Malicious dependency** | Run code at install or at runtime. | Secrets, a backdoor. |

The admin is trusted. The admin protects their own account with a second
factor; the instance can require it (see T10).

---

## T1. Authentication and account enumeration

| Mitigation | Test | Owner |
|---|---|---|
| Sign-in takes a username **or** email plus a password. Unknown account, wrong password and disabled account all answer the same `401 /problems/sign-in-failed` with the same body. For an unknown account, the server still verifies against a fixed dummy argon2id hash, so the time taken matches. | Integration test: the three cases give byte-identical bodies; timing differs by < 50 ms at p50 over 50 tries. | Accounts |
| No public sign-up. The only ways to create an account are the first-run admin setup and an invitation. | No route creates an account without a valid invitation token; test it. | Accounts, Invitations |
| Passwords: at least 12 characters, at most 256; no composition rules; checked against a bundled top-100k breached-password list (offline, no network call). Hashed with argon2id (see [stack.md](stack.md#password-hashing-argon2id-through-node-rsargon2)). | Unit tests for limits and the breached list. | Accounts |
| Invitation, reset and share-link pages answer the same "This link is not valid" for unknown, expired, used and revoked tokens. | Integration test. | Invitations, Share links |
| The first-run setup page is served only while no admin exists, and only to a request carrying the one-time setup token from the install step (see [deployment.md](deployment.md#first-admin)). | Test: once an admin exists, the setup route is 404. | Accounts |
| Changing the password or email needs a recent sign-in. A password change signs out every other session. | Integration test. | Accounts |

## T2. Sessions

| Mitigation | Test | Owner |
|---|---|---|
| Server-side sessions. The token is 32 random bytes (`crypto.randomBytes`), base64url, sent only in the cookie. The database holds only its SHA-256. | Unit test: no token in DB rows. | Accounts |
| Cookie: `__Host-nu_session`; `Secure; HttpOnly; SameSite=Strict; Path=/`; no `Domain`; no `Max-Age` (a browser-session cookie, as timeouts are server-side). `Strict` costs nothing here: the SPA's HTML needs no cookie, and its API calls are same-site, so a user arriving from an email link or an SSO redirect is still signed in once the app loads. | Integration test on `Set-Cookie`; Playwright: arriving from a cross-site link keeps the session. | Accounts |
| **Rotation**: a new token is issued (and the old one revoked) at sign-in, when the second factor is passed (`pending second factor` → `active`), when the role or password changes, and when a recent sign-in is renewed. | Integration test: the token before ≠ the token after each event, and the old one returns 401. | Accounts, 2FA |
| **Idle timeout**: 30 minutes for the admin, 2 hours for a user (settings, lower bound 5 minutes). **Absolute timeout**: 12 hours for the admin, 7 days for a user. A `pending second factor` session lives 5 minutes. `last_seen_at` is written at most once a minute. | Clock-injected unit tests. | Accounts |
| **Recent sign-in** (10 minutes) is required for: changing the password or email, adding or removing a second factor, viewing recovery codes again, linking or unlinking SSO, and for the admin: adding or editing a resource, SSO provider or SMTP settings, deleting a user. | Integration test per route (route table flag `recentSignIn: true`). | Accounts, 2FA |
| Sign-out revokes the session on the server and clears the cookie. **Settings → Sessions** lists the account's sessions and signs out any one or all. Disabling an account revokes all its sessions. | Integration test. | Accounts, Invitations |

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
| File and folder names are shown only as text nodes; `title` and `aria-label` attributes get them through React props. | Playwright test with a name like `<img src=x onerror=alert(1)>.txt`. | Files |
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
   requests carry no resource id at all.

| Mitigation | Test | Owner |
|---|---|---|
| The steps above. | Table-driven tests: `../`, `%2e%2e/` (decoded by Fastify first), `a/../../b`, `..\\`, absolute paths, NUL, overlong names, NFD names, a symlink to `/etc`, a symlink to a sibling home, a FIFO, a device, and a race test that swaps a folder for a symlink between resolve and open. | Resources |
| Hard links inside a resource that point outside it can only be made by someone with shell access (no route creates links). Documented as a residual risk for the local OS attacker; the install docs say to map folders that other OS users cannot write to. | Review. | Resources, Review |
| SMB mounts use `nosuid,nodev,noexec` and fixed `uid`/`gid` (see [smb.md](smb.md#mount-options)), so a share cannot add a device file or a setuid binary to the host. | Install-script test of the mount options. | Install |
| The lint rule `no-restricted-imports` forbids `node:fs` and `node:fs/promises` outside `modules/storage`, `modules/platform`, the files module's staging store (`modules/files/staging.ts`) and the resources module's mount-request writer (`modules/resources/mount-requests.ts`). | Lint. | Skeleton |

## T6. Secrets at rest: SMB credentials, TOTP seeds, SMTP and SSO secrets

| Mitigation | Test | Owner |
|---|---|---|
| **Envelope encryption** with AES-256-GCM (`node:crypto`). The format is version (1 byte) ‖ key id (4 bytes) ‖ nonce (12 random bytes) ‖ ciphertext ‖ tag (16 bytes), stored as base64url. **AAD** = `table:column:rowId`, so a ciphertext copied into another row or column fails to decrypt. | Unit tests: round-trip, a tampered byte fails, a swapped row fails. | Skeleton (the `secrets` module), Resources (first use) |
| **The key lives outside the database**: a 32-byte master key in `/etc/not-unreachable/credentials/master.key` (`root:root 0600`), handed to the service through systemd `LoadCredential=`, so the service reads it from `$CREDENTIALS_DIRECTORY` and the service user has no access to the file itself. Per-purpose keys are derived with HKDF-SHA-256 (`info = "nu/smb"`, `"nu/totp"`…). A backup of the database alone discloses no secret. | Startup test: the server refuses to start without the credential, and never logs it. | Skeleton, Install |
| **Rotation**: `not-unreachable rotate-key` (run as root with the service stopped) re-encrypts every envelope under a new key id. | CLI integration test. | Skeleton |
| Secrets never leave the server: the API returns `smbPasswordSet: true`, never the value. Editing a resource without typing a new password keeps the old one. | Contract test: no response schema has a secret field. | Resources, 2FA, SSO |
| Passwords, recovery codes and share-link passwords are **hashed** (argon2id), not encrypted. Session, invitation, reset, email-code and unlock tokens are stored as SHA-256 (they are already 256-bit random, so a slow hash adds nothing). | Unit tests. | Accounts, 2FA, Invitations, Share links |
| SMB passwords reach the kernel through two short-lived files on tmpfs: the app's request file (`0600`, service user) and the credentials file the mount helper writes (`root 0600`). The helper deletes both within the same run, whether the mount works or not (see [smb.md](smb.md#adding-a-share-at-runtime)). Passwords never appear on a command line or in the environment. | Helper test: after a successful and a failed mount, neither file exists. | Resources, Install |

## T7. Upload abuse

| Mitigation | Test | Owner |
|---|---|---|
| **Quota per user** (default 10 GiB, a setting; the admin can set it per user). Checked at tus creation with the declared `Upload-Length`, counting the home's used bytes plus that user's unfinished uploads; checked again at completion. The admin has no quota, but the disk-reserve rule below applies to the admin too. | Integration test: an upload declared over quota gets `413 /problems/quota-exceeded` before any byte is stored. | Files |
| **Size limit per file** (default 50 GiB, a setting) and `Upload-Length` required (no deferred length). Each `PATCH` body is at most 64 MiB; the client uses 16 MiB chunks. | Integration test. | Files |
| **Disk reserve**: an upload is refused if completing it would leave less than 5 % or 5 GiB free on the staging disk or the target (`statfs`). | Unit test with a faked `statfs`. | Files |
| **At most 4 uploads in progress per user** and 100 per instance; at most 20 tus creations per user per hour. | Integration test. | Files |
| **Cleanup**: an unfinished upload expires 24 hours after its last chunk. An hourly job deletes expired staging files and their rows, and at startup it removes staging files that have no row. A `.nu-upload-*` temporary file in a target older than 1 hour is removed by the same job. | Clock-injected test. | Files |
| Upload metadata (target, name) is validated at creation by T5's rules, so a bad target is rejected before any data is accepted. | Integration test. | Files |
| Staging lives in `/var/lib/not-unreachable/uploads`, outside every resource and the web root; staged files are `0600`. | Install-script test. | Files, Install |
| Downloads of uploaded content never render on our origin (T4). | – | Files |

## T8. Share-link abuse

| Mitigation | Test | Owner |
|---|---|---|
| **Token**: 32 random bytes (256 bits), base64url (43 characters), in the path: `/s/<token>`. Looked up by SHA-256. The token is also kept encrypted (T6), so the admin can copy the link again. It is never logged: pino cuts it out of `/s/<token>` and `/api/v1/public/share-links/<token>/…` alike. | Unit test of the redaction over both paths. | Share links |
| `Referrer-Policy: no-referrer` everywhere, so the token never leaks through `Referer`. | Header test. | Skeleton |
| **Link password**: optional, at least 8 characters, hashed with argon2id. A correct password creates an **unlock**: a random token in the cookie `__Host-nu_unlock_<linkId>` (`Secure; HttpOnly; SameSite=Strict; Path=/`), valid 12 hours or until the link expires, stored as SHA-256. Changing or removing the password deletes every unlock. | Integration test. | Share links |
| **Expiry**: default 7 days, chosen when the link is made; "No expiry" exists but has to be picked on purpose, and the link list marks those links. Expiry is checked on every request, including each range request of a download in progress; an expired link answers like an unknown one (T1). | Clock-injected test. | Share links |
| **Rate limits** on the public share API: unknown or invalid tokens: 20 per minute per IP (IPv6 by /64), then 429 for 15 minutes. Wrong link password: 5 per 15 minutes per IP per link, and 50 per hour per link across all IPs. After that the link locks for an hour: the audit log records `share-link.locked`, and the Share links list shows the link with a **Locked** badge until the hour is over. | Integration tests. | Share links |
| **Scope**: a folder link uses the shared folder as the root for T5, so `..` and symlinks cannot leave it. A link for a file allows only that file. | Path-safety tests run through the share API. | Share links |
| **Revocation** takes effect on the next request, including a download in progress at its next range request. | Integration test. | Share links |
| **Download cost**: at most 4 concurrent downloads per link per IP. Each download is counted, and the count is shown in the link list. | Integration test. | Share links |
| The share page is `noindex` (`X-Robots-Tag: noindex, nofollow`) and does not say which resource or path the link points into, only the shared item's own name. | Header test; Playwright. | Share links |

*Rejected:* putting the token in the URL fragment, which keeps it out of proxy
logs. Resumable downloads by download managers need a plain, stable URL. The
install docs instead show how to keep `/s/*` and `/api/v1/public/share-links/*`
out of the proxy's access log.

## T9. SSO account linking

| Mitigation | Test | Owner |
|---|---|---|
| **No auto sign-up and no linking by email.** An SSO identity signs in only if a linked sign-in for (provider, subject) exists. A matching email alone never links anything, because not every IdP verifies emails and some let users change them. | Integration test: an unknown subject with the admin's email is refused. | SSO |
| A link is made in only two ways: (a) on the invitation page, by choosing **Continue with <provider>**, which creates the account and the link in one go; (b) in **Settings → Linked sign-ins** with a recent sign-in. | Integration tests. | SSO |
| Authorization code flow with PKCE (S256), `state` and `nonce`, bound to the `__Host-nu_sso` cookie, single use, 10 minutes. ID token: signature, `iss`, `aud`, `exp`, `nonce`. The redirect URI is fixed to `PUBLIC_ORIGIN + /api/v1/sso/<providerId>/callback`. | Tests with a mock OIDC provider (`oidc-provider` in tests). | SSO |
| An SSO sign-in is a first factor only. If the account has a second factor, or the admin requires one, the session is still `pending second factor`. The admin may opt out per provider (**Trust this provider's 2FA**); this is off by default. | Integration test. | SSO |
| Unlinking the last sign-in method is refused (an account must keep a password, a passkey or another link). | Integration test. | SSO |
| A disabled SSO provider stops sign-in at once; its links stay so they work again if it is re-enabled. | Integration test. | SSO |

## T10. Second-factor bypass and recovery

| Mitigation | Test | Owner |
|---|---|---|
| Between password and second factor, the session is `pending second factor`. Every route except the second-factor endpoints and sign-out refuses it (the guard checks `state === "active"`). | Contract test over the route table: every non-public route has the `active` guard. | 2FA |
| TOTP: ±1 step, each step accepted once (`last_used_step`). Email codes: 6 digits, 10 minutes, at most 5 tries, then the code is void; at most 3 sent per 15 minutes per account. Codes are compared in constant time. | Unit tests. | 2FA |
| Second-factor attempts are limited to 5 per 15 minutes per session and 10 per hour per account; after that the pending session is revoked. | Integration test. | 2FA |
| **Recovery codes**: 10 codes of 10 base32 characters (50 bits each), shown once, argon2id-hashed, single use. Using one sends an email (if SMTP is set) and records `second-factor.recovery-code-used`. Regenerating them needs a recent sign-in and voids the old set. | Integration tests. | 2FA |
| **Lost all factors (user)**: the admin issues a password reset link and can **Remove second factors** for that account (audited). The user then has to add a factor again if the instance requires one. | Integration test. | Invitations, 2FA |
| **Lost all factors (admin)**: there is no web path. On the host, `sudo not-unreachable reset-admin` removes the admin's second factors, revokes the admin's sessions and prints a one-time setup link (audited as `system`). Shell access to the host is the proof. | CLI test. | Accounts |
| **Require two-step sign-in** (setting, on by default for the admin and off for users): an account without a factor is sent to enrolment right after the password and can do nothing else until it has one. | Integration test. | 2FA |
| Passkeys: `userVerification` required for passwordless sign-in; challenge single use, 5 minutes; the signature counter is checked when the authenticator reports one; origin and RP ID must match `PUBLIC_ORIGIN`. | Tests with Playwright's virtual authenticator. | Passkeys |

## T11. Rate limiting

All limits are configurable settings with these defaults. IPs come from
Fastify's `request.ip` with `trustProxy` set to `TRUSTED_PROXIES` only (see
[deployment.md](deployment.md#tls-and-the-reverse-proxy)). IPv6 addresses are
grouped by /64. A rejected request gets `429` with `Retry-After`.

| Limit | Key | Default | Store | Owner |
|---|---|---|---|---|
| Global API | IP | 600 requests / minute | memory (`@fastify/rate-limit`) | Skeleton |
| Sign-in attempts | IP | 10 / minute, 50 / hour | memory | Accounts |
| Sign-in failures | account | after 5 failures, delay grows (1 s, 2 s, 4 s … capped at 60 s); after 20 in an hour, locked 15 minutes. **No permanent lockout**, so nobody can lock an account out for good. | DB (`sign_in_failures`) | Accounts |
| Second factor | session / account | see T10 | DB | 2FA |
| Email codes sent | account | 3 / 15 minutes | DB | 2FA |
| Invitation / reset page | IP | 20 / minute | memory | Invitations |
| Share links | IP / link | see T8 | memory + DB | Share links |
| Uploads | user | see T7 | DB | Files |
| argon2id hashing | process | 4 in parallel; the rest queue for at most 5 s, then 503 | memory | Accounts |

Memory stores are enough because the app runs as one process. The per-account
counters persist in the database, so a restart does not reset them. A sign-in
lockout sends an email to the account (if SMTP is set) and appears in the audit
log.

## T12. The audit log

| Mitigation | Test | Owner |
|---|---|---|
| An append-only table. The app has no update route and no delete route, other than the retention purge. The UI is read-only, with filters (time, actor, action, outcome) and CSV export. | Contract test. | Accounts (module), each feature Task for its own events |
| **Recorded for each event**: time, actor kind (`account`, `share-link`, `anonymous`, `system`) and id, action, target kind and id, outcome (`succeeded`/`failed`/`denied`), IP, user agent (first 256 characters), and details as JSON. **Never recorded**: passwords, codes, tokens, secrets, file contents. Paths are recorded. | Unit test: details schemas per action have no secret fields. | each owner |
| **Events** (at least): `setup-link.issued`, `setup.completed`, `account.created` / `.enabled`, `sign-in.succeeded` / `.failed` / `.locked`, `sign-out`, `session.revoked`, `second-factor.added` / `.removed` / `.failed` / `.recovery-code-used`, `password.changed`, `password-reset-link.issued` / `.used`, `invitation.created` / `.accepted` / `.revoked`, `account.disabled` / `.deleted`, `linked-sign-in.added` / `.removed`, `sso-provider.changed`, `settings.changed` (which keys, not secret values), `resource.added` / `.changed` / `.removed` / `.mount-failed`, `home-root.changed`, `file.uploaded` / `.deleted`, `share-link.created` / `.changed` / `.revoked` / `.downloaded` / `.password-failed` / `.locked`, `rate-limit.triggered` (once per key per window), `system.started` / `.migrated` / `.key-rotated`. File downloads by the admin and by users are not recorded (too noisy); share-link downloads are. | Integration test per event in its owner Task. | each owner |
| **Retention**: 365 days by default (setting, 30–3650). A daily job purges older events and records `audit.purged` with the count. | Clock-injected test. | Accounts |
| Events are also written to the log (journald) as JSON, so an attacker with admin access to the app cannot remove the copy on the host. | Test that `record()` logs. | Accounts |

## T13. Security headers and supply chain

**Headers** (through `@fastify/helmet`, on every response): the CSP from T4;
`Strict-Transport-Security: max-age=31536000` (`includeSubDomains` only when
`HSTS_INCLUDE_SUBDOMAINS=true`); `X-Content-Type-Options: nosniff`;
`Referrer-Policy: no-referrer`; `Cross-Origin-Opener-Policy: same-origin`;
`Cross-Origin-Resource-Policy: same-origin`; `X-Frame-Options: DENY`;
`Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), publickey-credentials-get=(self), publickey-credentials-create=(self)`;
`Cache-Control: no-store` on every `/api` response except file downloads,
which get `private, no-cache`. `Server` and `X-Powered-By` are not sent.
Owner: **Skeleton**; test: a header snapshot test over one route of each kind.

**Supply chain** (owner **Skeleton**, checked by **Review**):

- `pnpm-lock.yaml` committed; CI installs with `--frozen-lockfile`.
- pnpm 10's lifecycle scripts are off by default; `onlyBuiltDependencies`
  allows exactly `better-sqlite3`, whose install script fetches its prebuilt
  binary (or compiles it where none exists). @node-rs/argon2 needs no script:
  its binaries come as optional dependencies.
- `minimumReleaseAge: 4320` (3 days) in `pnpm-workspace.yaml`, so a freshly
  hijacked release is not picked up the day it is published.
- Few dependencies: each new runtime dependency is named in the Task that adds
  it, with why.
- CI runs `pnpm audit --prod --audit-level=high` and fails on findings.
  Renovate opens grouped weekly updates; security updates come at once.
- Each release tarball has a SHA-256 checksum and a CycloneDX SBOM, made by
  `@cyclonedx/cdxgen` from the lockfile.

## T14. The local OS attacker and the mount helper

| Mitigation | Test | Owner |
|---|---|---|
| The service runs as the system user `not-unreachable` (no shell, no login) with the systemd hardening in [deployment.md](deployment.md#systemd-unit). Its data directory is `0700`; config `0640 root:not-unreachable`; the master key is reachable only through `LoadCredential=`. | `systemd-analyze security not-unreachable` exposure score ≤ 2.0, checked by the install script. | Install |
| The service listens on `127.0.0.1:8480` by default, never on `0.0.0.0` unless configured. | Config test. | Skeleton |
| The mount helper is the only root code. Polkit lets the service user start and stop **only** units matching `not-unreachable-mount@<uuid>.service`. The helper validates the share id as a UUID, opens its request from a path it derives itself with `O_NOFOLLOW` and checks the descriptor (regular file, owner, mode, size), validates every field against strict patterns, and sets every mount option itself. It **never writes into a directory the service user controls**: the result is its exit code, and mount points are under the root-owned `/srv/not-unreachable/mounts` (see [smb.md](smb.md#what-happens-underneath)). | Helper tests as root with hostile requests: option injection like `host,uid=0`, `../` in the share name, a symlinked or swapped request file, a FIFO, a file owned by another user. | Resources, Install |
| An SMB server on a hostile LAN: SMB 3.1.1 by default; signing (`sign`) is always required; encryption (`seal`) is on by default, and the UI warns wherever it is off. With it on, file contents and credentials are not in clear text on the wire. SMB 3.0 and 2.1 are offered only for older servers, and only when the admin picks them. | Helper test of the options per protocol choice. | Resources |

## T15. Open redirects, Host header and SSRF

| Mitigation | Test | Owner |
|---|---|---|
| Every absolute URL the app makes (invitation links, emails, SSO redirect URIs, passkey origin) comes from `PUBLIC_ORIGIN`, never from the `Host` or `X-Forwarded-Host` header. | Test with a forged `Host`. | Skeleton |
| After sign-in, `?next=` is accepted only as a relative path starting with a single `/` and matching a known SPA route. | Unit test with `//evil`, `/\evil`, `https:`. | Accounts |
| SSO issuer URLs and SMB hosts are entered by the admin only. Issuers must be `https://`. The server fetches nothing else on anyone's behalf. | Validation tests. | SSO, Resources |

## Residual risks (accepted)

- A compromised admin account can read every resource. A second factor is
  required for the admin by default (T10), and every action is audited.
- Hard links placed in a resource by a local OS user (T5).
- Memory rate-limit counters reset on restart (the per-account ones do not).
- The reverse proxy's own access log may hold share-link tokens, unless it is
  configured as the deployment docs show.
