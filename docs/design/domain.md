# Domain and modules

The words below are the words the UI shows. Code, API paths, tables and logs use
the same words (`shareLink`, `share_links`, `/api/v1/share-links`). A concept
gets no second, technical name. When a new concept needs a name, it is added to
this glossary first.

## Glossary

### People and access

| Term | Meaning |
|---|---|
| **Admin** | The one account with the `admin` role. It configures everything, browses every resource, and manages users, invitations and share links. Exactly one exists (a partial unique index); it is created at first run (see [deployment.md](deployment.md#first-admin)). |
| **User** | An account with the `user` role. A user sees only their own home: lists, uploads, downloads and deletes files there, and manages their own sign-in methods. |
| **Account** | The record behind an admin or a user, one `users` row each: username, email (always set for the admin, optional for a user), display name, role, status (`active` / `disabled`), an optional quota, and its sign-in methods, each in a table of its own keyed by the user. Only the admin has a password. The **username** is unique, lowercase `[a-z0-9._-]{3,32}`, and cannot change after the account is created, because the home folder is named after it. |
| **Invitation** | A single-use link the admin creates so that one new user can create an account. It has an optional email, which becomes the new account's email if no account has it and never links a sign-in to an account, an expiry (1, 7 (default) or 30 days), and a state: `pending`, `accepted`, `expired` or `revoked`. With an email, the admin chooses **Send the invitation to this email** (needs SMTP set up) and **Require a verified matching email**, which is always on for an invitation sent by email. Such an invitation can only be accepted through a provider that reports that very email as verified (threat model, T9); otherwise the invitation page says the email isn't verified or doesn't match, and nothing is created. The admin can copy the link again, resend an invitation sent by email, or revoke it. The invitee picks a username and display name, then chooses **Continue with <provider>**; that creates the account, its linked sign-in and its home in one go. It is the only way a user account comes into being. Users have no password, so there is no password reset. |
| **Re-link link** | A single-use link, valid 1 day, that the admin creates for an existing user from the Users screen (with a recent sign-in), and that is emailed when the user has an email and SMTP is set. Using it links a new identity to the same account, removes the old linked sign-ins and signs out every other session. It is how a user who lost their provider account gets back in. |
| **Sign-in** | Proving who you are. The admin signs in with a password (reset only by `not-unreachable reset-admin` on the host, which prints a one-time `/setup#<token>` link) or through a linked SSO provider, and either way always goes on to the second factor. Users sign in **only** through an SSO provider they have a linked sign-in for, and rely on that provider's own MFA. The admin can also sign in with a passkey alone (passwordless), which needs user verification and counts as both steps. |
| **Second factor** | Something an account adds to its password: an **authenticator app** (TOTP) or a **passkey**. The admin, the only account with a password, always needs one; users sign in with SSO and rely on their provider's own MFA. "Two-step sign-in" in the UI is the same as 2FA. There are no email codes. |
| **Authenticator app** | A TOTP second factor: a secret shared with an app on the admin's phone, shown once as a QR code and a setup key, and confirmed with a code. More than one app may be added. |
| **Passkey** | A WebAuthn credential, kept by the browser, the device or a password manager ("Synced" when backed up). It can serve as a second factor, or sign in on its own (passwordless), since it already proves possession and user verification. The admin registers, renames and removes passkeys in **Settings → Two-step sign-in**, or adds one instead of an authenticator app at a forced enrolment. Only the admin has them for now. |
| **Recovery code** | One of 10 single-use codes, shown once (as `ABCDE-FGH23`) when the first second factor is added. Each code stands in for the second factor exactly once. They can only be regenerated, which voids all earlier ones. |
| **SSO provider** | An external sign-in service the admin configures on the **Sign-in providers** tab: Google (issuer fixed to `https://accounts.google.com`), GitHub (OAuth 2; the constant issuer `https://github.com`) or a generic OIDC provider (an `https://` issuer, checked by discovery when saved). Each has a name, client ID, write-only client secret and an enabled switch; issuers are unique. One with linked sign-ins can only be disabled, never removed, and its issuer can't change. |
| **Linked sign-in** | An account's link to one identity at one SSO provider, identified **only** by (issuer, subject), unique across all accounts; the provider's email is kept for display only and never links anything (an invitation may require a verified one before it is accepted). Created only by a signed-in account choosing **Link** in **Settings → Linked sign-ins** with a recent sign-in, by accepting an invitation through that provider, or by using a re-link link. A user can't unlink their last one; the admin, who has a password, can. |
| **Session** | One signed-in browser. It can be listed and signed out in **Settings → Sessions**. A session is `pending second factor` after the password, for at most 5 minutes and without a recent sign-in, until the second factor is passed (or, when the admin has none yet, enrolled and its recovery codes saved); it is then `active`. A pending session reaches only the second-factor sign-in routes, sign-out and `GET /api/v1/session`. |
| **Recent sign-in** | A session that proved the password or an authenticator code in the last 10 minutes. Sensitive actions ask for it again (see the threat model). |

### Storage

| Term | Meaning |
|---|---|
| **Resource** | A place the admin maps for the app to use: a **local folder** (an absolute path on the server) or an **SMB share** (`//host/share`, with credentials). Each has a name shown in the UI, and a state: `available` or `unavailable` (with the reason). Nothing outside a resource is ever reachable. |
| **Local folder** | A resource backed by a directory on the server's disks. |
| **SMB share** | A resource backed by a Windows/Samba share, mounted by the system (see [smb.md](smb.md)). |
| **Home root** | The one resource (or one folder inside a resource) the admin picks to hold the homes. Until it is set, users cannot be invited. |
| **Home** | A user's own folder, `<home root>/<username>`, created with the account. For that user, it is the whole visible file system. |
| **Folder / file** | Entries inside a resource. "Path" in the UI and the API is always relative to a resource (or to the home, for a user) and uses `/`. |
| **Upload** | A file being sent in chunks. It can pause and resume, and appears under the target folder only once complete. |
| **Quota** | The most bytes a user's home may hold, uploads in progress included. Set by the admin per user, with a default. |
| **Share link** | A link the admin creates for a file or a folder. Who can open it is set by its **link access**. It may also have a **link password** and an **expiry**, and can be revoked. A folder link lets the holder browse and download inside that folder only. |
| **Link access** | Who can open a share link: **Anyone with the link** (no account needed; the default), **Signed-in users** (any account signed in here: the users and the admin), or **Selected users** (only the users the admin picks, and the admin). The link password applies on top of any of them. A removed user leaves every link's list; a "Selected users" link whose list ends up empty stays so, and only the admin can open it. |
| **Shared with me** | A user's page (`/shared`) listing the share links they can open: every active **Signed-in users** link, and every active **Selected users** link that lists them. It never lists **Anyone with the link** links, nor revoked or expired ones. Each row shows only the item's own name, whether it is a file or a folder, its expiry and whether it has a link password, and opens the link's own share page. The admin has no such page; they manage every link in Share links. |
| **Audit event** | One record in the **audit log**: who did what, to what, when, from where, and whether it worked. |
| **Settings** | Instance-wide options the admin sets in the admin interface: SMTP, SSO providers, session timeouts, quotas, upload limits, audit-log retention. Bootstrap options that must be known before the database opens live in the config file instead (see [deployment.md](deployment.md#config-secrets-and-data)). |

## The two interfaces after one login

- One sign-in page at `/sign-in`, for both roles. After sign-in (and the second
  factor, once it exists), the server answers with the account's role. While no
  admin exists, every page redirects to `/setup`. The SPA routes the admin to the
  Dashboard (`/admin/dashboard`: the instance's counts and its recent activity) and a
  user to `/files`.
- Both interfaces live in one SPA build, as two lazy route trees, so a user's
  browser never downloads the admin interface's code.
- Separation is enforced **on the server**: every `/api/v1/admin/*` route's
  contract requires the `admin` role (a user gets 403), and a contract test fails if one does
  not (see rule 5 under [Server modules](#server-modules)). User routes are scoped to the caller's home
  by the files module, never by a path the client sends. The SPA split is for
  the user's convenience, not for security.
- Shared screens: `/sign-in`, `/setup` (first admin or admin reset), `/invitation/:token` (create account),
  `/relink/:token` (link a new sign-in), `/settings/*` (each account's own Profile, Password (admin
  only), Sessions; later second factors and linked sign-ins). The public share page `/s/:token` needs
  no account.

| Admin interface (`/admin`) | User interface (`/files`) |
|---|---|
| Files: every resource, browse, upload, download, delete, create share link | Files: own home only, browse, upload, download, delete |
| Share links: list, edit expiry/password/access, revoke | Shared with me: the share links they can open; open one whose access lets them in |
| Users: list, quota, disable, unlink a sign-in, send re-link link, remove (keep or delete files), browse a user's files | – |
| Dashboard: counts, Recent uploads (users who uploaded in the last 7 days), recent activity | – |
| Invitations: create, list, copy link, resend, revoke | – |
| Resources: add/edit/remove local folder or SMB share, test, choose home root | – |
| Settings: Email (SMTP), SSO providers, security policy, limits, retention | – |
| Audit log: filter and read | – |

The admin opens a user's home (`/admin/users/:id/files`) from Users or from the Dashboard's Recent
uploads. It is the Files browser scoped to the home's folder in its resource: every operation goes
through the admin file routes of that resource, so no user route changes and a user still reaches only
their own home. The admin's uploads there are outside the user's quota, like all the admin's uploads,
and Recent uploads counts only users' own successful uploads (`file.uploaded`), never the admin's.

## Server modules

The server is one Fastify app made of modules under `apps/server/src/modules/`.
Each module is a Fastify plugin with this inner layout:

```
modules/<name>/
  index.ts        the module's public interface: its plugin and its service type
  routes.ts       HTTP routes (contracts-validated) → calls the service
  service.ts      use cases; the only place that holds business rules
  repository.ts   Drizzle queries on the module's own tables
  *.test.ts
```

**Rules**

1. Another module may import only a module's `index.ts`. Deep imports
   (`modules/x/repository`) are lint errors (`no-restricted-imports`).
2. A module reads and writes only its own tables. It reaches other data through
   that module's service.
3. A module depends only on modules in lower layers of the table below; cycles
   are lint errors (`import/no-cycle`).
4. Routes never touch `fs` or the database directly. Files inside resources
   are reached only through `storage` and a `ContainedPath` (below). The only
   other code allowed to import `node:fs` is `platform` (config, database
   file), the files module's upload staging store, the resources module's
   mount-request writer and its folder-request writer
   (`modules/resources/folder-requests.ts`), and the updates module's spool
   (`modules/updates/spool.ts`: the downloaded release files, the update
   request and the update helper's status file), all outside every resource. The
   systemd drop-in writer lives with the root helpers
   (`deploy/mount-helper/src/folder-access.mts`), run only as root by the CLI
   command `allow-folder` and the folder helper (lint rule in
   [T5](threat-model.md#t5-path-traversal-symlinks-and-special-files)).
5. **Guards are not imported by modules.** Each route's contract in
   `packages/contracts` states who may call it (`public`, `pendingSecondFactor`,
   `user`, `admin`) and whether it needs a recent sign-in. The composition root
   (`apps/server/src/app.ts`) registers the `sessions` plugin before every
   module; it resolves the caller's session and enforces the contract's
   requirements before any handler runs. Handlers read the caller from the
   request context. So a module needs `sessions` only when it changes
   sessions itself, and a route without a stated requirement can't be
   registered.

| Layer | Module | Owns | Depends on |
|---|---|---|---|
| 0 | `platform` | config loading (zod), database handle and migrations, logger, clock, `secrets` (AES-GCM envelope, keyed hashes), `rate-limits`, problem+json errors, request context (IP, caller), token helpers, a clock-injected `jobs` scheduler | – |
| 1 | `audit` | `audit_events`; `record(event)`; the Audit log API; retention purge job (daily) | platform |
| 1 | `mail` | `mail_settings` (SMTP, encrypted password); nodemailer; `send(template, to)` with the templates invitation, relink, test and security-notice, in plain text and HTML, links built from `PUBLIC_ORIGIN`; the Send test email action | platform |
| 1 | `settings` | `settings` table: typed instance settings | platform |
| 1 | `health` | health routes | platform |
| 1 | `storage` | `resolveInResource()` / `ContainedPath`, safe open, list, stat, delete, move-into-place | platform (no other module) |
| 2 | `accounts` | `users`, `password_credentials`, `setup_tokens`; password hashing and rules, first admin setup, admin reset | platform, audit, settings |
| 2 | `security-settings` | the admin's Security tab: reads and updates the sign-in and session settings, audited | audit, settings |
| 3 | `sessions` | `sessions`, cookie handling, timeouts, the guard hook that enforces each contract's requirements, revoking sessions | platform, audit, accounts |
| 3 | `second-factors` | `totp_credentials`, `recovery_codes`, `second_factor_failures`, `passkey_credentials`, `webauthn_challenges`; TOTP enrolment and confirmation, passkey registration and verification (`PasskeysService`, the relying party from `PUBLIC_ORIGIN`), recovery codes, the try limits, the sweep job; `hasSecondFactor(userId)` and `listFactors(userId)`, which count both kinds; a `notify()` seam for security notices, which are emailed to the account holder once SMTP is set. The sign-in step itself lives in `sign-in` | platform, audit, accounts |
| 3 | `sso` | `sso_providers`, `linked_sign_ins`, `sso_flows` and the job that purges expired flows; the OIDC/GitHub flows (openid-client), and a registry of flow **purposes** (`link`, `sign-in`, `accept-invitation` and `relink`) the callback hands the checked identity to | platform, audit, accounts, settings |
| 3 | `resources` | `resources`, `homes`; the resource-kind registry (local folders; SMB mount control, which talks to the mount helper, comes with the SMB Task); home root and homes (`homeFor`, `createHome`), `rootFor`; the startup re-check; the `allow-folder` drop-in; allowing a folder from the admin interface through the folder helper (only while `ALLOW_FOLDERS_FROM_UI` is on) | platform, audit, settings, storage |
| 4 | `invitations` | `invitations`, `reserved_usernames`; invitations and re-link links; the public accept and re-link use cases (SSO purposes `accept-invitation` and `relink`); the Users screen's use cases (disable, quota, unlink, remove), which span accounts, sessions, sso and resources | platform, audit, mail, accounts, settings, sessions, sso, resources |
| 4 | `sign-in` | the sign-in flow across password, passkey, SSO and second factor (the second-factor step, `second-factor-step.ts`, uses `sessions` and `second-factors`); enumeration-safe answers; `sign_in_failures`, `sign_in_locks` and their daily sweep job | accounts, sessions, second-factors, sso, audit |
| 4 | `updates` | `update_checks`, `update_requests`; the check for new releases (GitHub, cached, every 6 hours, only while `UPDATE_CHECK` is on), the download into the spool, installing from Settings through the update helper (only while `UPDATE_FROM_UI` is on), recording `update.finished` once and its mail ([deployment.md](deployment.md#updating-from-settings)) | platform, audit, mail, resources (its `systemctl` runner) |
| 4 | `files` | browse, Range downloads, delete, tus uploads (`uploads` table, staging, quotas, upload limits, hourly cleanup job) | accounts (`findById`, for `quota_bytes`), resources, storage, audit, settings |
| 5 | `share-links` | `share_links`, `share_link_unlocks`, public share page API | files, storage, resources, accounts, audit |
| 6 | `dashboard` | no tables; the admin Dashboard's counts, each one aggregate query in the module that owns the table (`countUsers`, `countPending`, `countByState`, `counts`), and Recent uploads from the audit log (`uploadersSince`) | accounts, audit, invitations, resources, share-links |

`storage` sits on its own so its correctness can be proven alone. It knows
nothing about accounts or roles: callers pass it a resource root (or a home)
and a relative path, and it returns a `ContainedPath` or throws.

**Resource kinds.** `resources` reaches each kind through a registry of
`ResourceKind` definitions: `validateConfig` (on add, change and "Check
folder"), `activate` (answers the root's real path, or Unavailable with the
reason, at startup and on Retry), `deactivate` (on remove), `test` and
`onStartup`. The service never branches on the kind. Only `local` is
registered so far. The contracts give each kind one branch of a discriminated
union on `kind`, so the SMB Task adds its kind, its contract branch and its
columns without changing `storage` or the files routes, which only ever ask
`rootFor(resourceId)` or `homeFor(username)` for a root.

## Path safety

```ts
// apps/server/src/modules/storage/index.ts
type ContainedPath = { readonly root: RealPath; readonly relative: string; readonly absolute: RealPath };
function resolveInResource(root: RealPath, relative: string): Promise<ContainedPath>;
function openContained(path: ContainedPath, mode: "read" | "write"): Promise<FileHandle>;
```

`ContainedPath` is a branded type that only `resolveInResource` can make, so
no other code can hand a raw string to the file system. The exact checks are in
the [threat model](threat-model.md#t5-path-traversal-symlinks-and-special-files).

## Files and uploads

- **Browse.** `GET /api/v1/admin/resources/:resourceId/entries?path=` for the
  admin; `GET /api/v1/home/entries?path=` for a user (the root is the caller's
  home, resolved on the server). `POST …/folders` makes a folder. The same
  routes sit under `/api/v1/admin/resources/:resourceId/` (`entries`,
  `folders`, `content`) and `/api/v1/home/` (`entries`, `folders`, `content`,
  and `quota` for the caller's used bytes and limit).
- **Download.** `GET …/content?path=` with Range support: one byte range
  answers 206 (`If-Range` checked against a strong ETag or the modification
  time), an unsatisfiable one 416, and several ranges or a malformed header
  the whole file with 200. Always `Content-Disposition: attachment`,
  `Content-Type: application/octet-stream`, `X-Content-Type-Options: nosniff`
  and a sandboxing CSP (`default-src 'none'; frame-ancestors 'none'; sandbox`).
- **Delete.** `DELETE …/entries?path=`. Deleting a folder needs
  `recursive=true`, and the UI confirms it.
- **Upload.** `POST /api/v1/uploads` (tus creation; `HEAD`, `PATCH` and
  `DELETE` on `/api/v1/uploads/:id`) with `Upload-Metadata` giving the folder
  path, the file name, `onConflict` and, for the admin only, the `resourceId`
  (a user's target is always their own home). The server checks the target,
  name, size, name conflict, quota and disk reserve **at creation** and again
  when the last chunk arrives. Chunks go to `<DATA_DIR>/uploads/<uploadId>`.
  On completion the file is copied into a temporary name in the target folder
  (`.nu-upload-<uploadId>`, recorded on the upload row as `temp_name`),
  `fsync`ed, then renamed to the final name, so no half-written file ever
  appears under its real name. An existing file with the same name is never
  overwritten silently. `onConflict` is `fail` (the default: 409 `name-taken`,
  and the client asks **Replace** or **Keep both**), `replace`, or `keep-both`
  (`name (1).ext`).
- **Quota.** A user's limit is `users.quota_bytes`, else the
  `defaultQuotaBytes` setting. Used bytes are the bytes in the home plus the
  user's unfinished uploads, each counted at its declared size. The admin has
  no quota; the disk reserve applies to everyone.

## Main tables

All ids are UUIDv7 (time-ordered) text. All times are UTC ISO-8601 text.
Columns marked 🔒 hold `secrets` envelopes (see the threat model). Columns
marked # hold SHA-256 hashes, never the token itself.

| Table | Key columns |
|---|---|
| `users` | id, username (unique), email (unique, nullable), display_name, role (`admin`/`user`; partial unique index allows one `admin`), status, quota_bytes (nullable: the `defaultQuotaBytes` setting applies), created_at, disabled_at |
| `password_credentials` | user_id (key), hash (argon2id), created_at, updated_at. Every credential kind gets its own table keyed by user_id; 2FA, passkeys and SSO add theirs |
| `setup_tokens` | id, purpose (`first-run`/`admin-reset`), token_hash #, user_id (nullable), created_at, expires_at, used_at |
| `sessions` | id, token_hash #, user_id, state (`pending_second_factor`/`active`), sign_in_method (`password`/`sso`/`passkey`, for the audit log), created_at, last_seen_at (written at most once a minute), recent_sign_in_at, ip, user_agent, revoked_at |
| `totp_credentials` | id, user_id, secret 🔒 (HKDF purpose `nu/totp`), last_used_step (each step passes once), created_at, confirmed_at, last_used_at, enrolment_session_id. An unconfirmed enrolment is void after 10 minutes and swept every 5 minutes |
| `recovery_codes` | id, user_id, batch_id, code_hash (argon2id), created_at, used_at. Regenerating voids the earlier batch |
| `second_factor_failures` | id, user_id, session_id, at. Feeds the try limits; rows older than an hour are swept |
| `passkey_credentials` | id, user_id, credential_id (unique), public_key (COSE), counter (signature counter; once above 0 it must increase), transports, backed_up (shown as "Synced"), name, created_at, last_used_at, enrolment_session_id (only the session that enrolled the first factor can acknowledge its recovery codes) |
| `webauthn_challenges` | id, purpose (`register`/`second-factor`/`passwordless`/`confirm`), challenge, user_id or session_id or browser_token_hash (the `__Host-nu_webauthn` cookie, for passwordless sign-in), created_at, expires_at (5 minutes), used_at (single use). Swept every 5 minutes |
| `sso_providers` | id, kind (`google`/`github`/`oidc`), name, issuer (unique), client_id, client_secret 🔒 (HKDF purpose `nu/sso`, AAD `sso_providers:client_secret:<id>`), enabled, created_at, updated_at |
| `linked_sign_ins` | id, user_id, provider_id (no delete while linked), issuer, subject, email_at_link (display only), created_at, last_used_at. (issuer, subject) is unique, and lookups use only that pair |
| `sso_flows` | id, provider_id, purpose, binding_hash # (of the `__Host-nu_sso` cookie), state, nonce (OIDC only), code_verifier 🔒, account_id and session_id (for purposes acting for a signed-in account, such as linking), purpose_data (JSON a purpose keeps with its flow, never secrets), created_at, expires_at (10 minutes). Taken once at the callback; a job purges expired ones |
| `invitations` | id, kind (`invite`/`relink`), target_user_id (re-link only), token_hash #, token 🔒 (HKDF purpose `nu/invitation`, so the admin can copy the link again), email, send_by_email, verify_email (both false for re-link links), created_by, expires_at, accepted_user_id, accepted_at, revoked_at, created_at |
| `reserved_usernames` | username (key), created_at. A name kept after a user is removed with "Keep files"; it holds only while that home folder still exists, and is dropped when checked and the folder is gone |
| `mail_settings` | id (one row), host, port, tls_mode (`starttls`/`tls`/`none`), username, password 🔒 (HKDF purpose `nu/smtp`), from_address, updated_at |
| `resources` | id, name (unique), kind (`local`/`smb`), local_path (`local` only, as the admin typed it), root_realpath (fixed on save, re-checked at startup; for `smb` the mount point), is_home_root (partial unique index: at most one), home_root_subpath, state (`available`/`unavailable`), unavailable_reason, created_at. `smb` only: smb_host, smb_share, smb_subfolder ("" for the share's top folder), smb_username, smb_password 🔒 (HKDF purpose `nu/smb`, AAD `resources:smb_password:<id>`), smb_domain, smb_protocol (`3.1.1`/`3.0`/`2.1`), smb_encrypt (as used: never true on `2.1`) |
| `homes` | username (key), resource_id (restrict on delete), path (relative to the resource), created_at. Each home's place is recorded when it is created, so changing the home root never moves an existing home, and a resource that holds homes can't be removed |
| `uploads` | id (the tus upload id), account_id (cascade on delete), target_resource_id (null for a home), target_path (the folder), file_name, size (declared), offset, staged_path, on_conflict (`fail`/`replace`/`keep-both`), created_at, last_chunk_at, expires_at (24 hours after the last chunk), temp_name (the `.nu-upload-*` file while it is being moved into place, else null), completed_at; indexes on account_id and expires_at |
| `share_links` | id, token_hash #, token 🔒 (so the admin can copy it again), resource_id (cascade on delete), path (relative to the resource), kind (`file`/`folder`), password_hash (nullable), expires_at (null only for "No expiry", chosen on purpose), locked_until (set for an hour after too many wrong passwords, else null), created_by (set null on delete), created_at, revoked_at, download_count, last_used_at; indexes on (created_at, id) and resource_id |
| `share_link_unlocks` | id, share_link_id (cascade on delete), unlock_hash #, expires_at (12 hours after the unlock, capped at the link's expiry); any change of the link's password deletes them all, and a daily job purges expired ones |
| `sign_in_failures` | subject_key, ip_key, failures, last_failure_at, delayed_until; key (subject_key, ip_key). The subject is `account:<user_id>`, or `identifier:<HMAC>` for an identifier that names no account (threat model, T1), so no foreign key. |
| `sign_in_locks` | subject_key, window_started_at, failures, locked_until; keyed like `sign_in_failures` |
| `settings` | key, value (JSON, validated by its zod schema), updated_at, updated_by |
| `audit_events` | id, at, actor_kind, actor_account_id, actor_username, action, target_kind, target_id, outcome, ip, user_agent, details (JSON); indexes on at, action, actor |

## API style

- REST over JSON under `/api/v1`. Resource-oriented paths with plural nouns
  matching the glossary: `/admin/share-links`, `/admin/invitations`,
  `/admin/resources`, `/home/entries`, `/settings/sessions`.
- `packages/contracts` defines every route: method, path, params, query, body
  and response as zod schemas, plus its required role. The server registers
  routes from that table, so an unlisted route cannot exist, and the web client
  calls them by name with full types.
- Errors are RFC 9457 `application/problem+json` with a stable `type`
  (`/problems/quota-exceeded`) that the UI maps to its wording. Error bodies
  never contain stack traces or file-system paths.
- State-changing requests need `Content-Type: application/json` (tus uses
  `application/offset+octet-stream`) and the CSRF checks in the threat model.
- Pagination: cursor-based (`?cursor=&limit=`, at most 200) for the audit log,
  share links and large folders.
- The public share API lives apart from the rest, under `/api/v1/public/share-links/:token/*`,
  with its own rate limits and no session. Its token is cut out of every log
  line, as for `/s/:token` (threat model, T8).
