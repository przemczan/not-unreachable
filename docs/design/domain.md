# Domain and modules

The words below are the words the UI shows. Code, API paths, tables and logs use
the same words (`shareLink`, `share_links`, `/api/v1/share-links`). A concept
gets no second, technical name. When a new concept needs a name, it is added to
this glossary first.

## Glossary

### People and access

| Term | Meaning |
|---|---|
| **Admin** | The one account with the `admin` role. It configures everything, browses every resource, and manages users, invitations and share links. Exactly one exists; it is created at first run (see [deployment.md](deployment.md#first-admin)). |
| **User** | An account with the `user` role. A user sees only their own home: lists, uploads, downloads and deletes files there, and manages their own sign-in methods. |
| **Account** | The record behind an admin or a user: username, email, display name, role, status (`active` / `disabled`) and its sign-in methods. The **username** is unique, lowercase `[a-z0-9._-]{3,32}`, and cannot change after the account is created, because the home folder is named after it. |
| **Invitation** | A single-use link the admin creates so that one new user can create an account. It has an optional email it is meant for, an expiry (default 7 days), and a state: `pending`, `accepted`, `expired` or `revoked`. It is the only way a user account comes into being. |
| **Password reset link** | A single-use link the admin issues for an existing account. It works like an invitation, but sets a new password for that account. There is no self-service reset by email in this Initiative (see the [task map](README.md#task-map)). |
| **Sign-in** | Proving who you are: with a password or an SSO provider, followed by a second factor when the account has one or the admin requires one; or with a passkey alone (passwordless), which already counts as both steps. |
| **Second factor** | Something an account adds to its password: an **authenticator app** (TOTP), **email codes**, or a **passkey**. "Two-step sign-in" in the UI is the same as 2FA. |
| **Authenticator app** | A TOTP second factor: a secret shared with an app on the user's phone, shown once as a QR code. |
| **Email code** | A one-time 6-digit code sent by email, valid for 10 minutes, for one sign-in. Available only when the admin has set up SMTP. |
| **Passkey** | A WebAuthn credential. It can serve as a second factor, or sign in on its own (passwordless), since it already proves possession and user verification. |
| **Recovery code** | One of 10 single-use codes, shown once when the first second factor is added. Each code stands in for the second factor exactly once. |
| **SSO provider** | An external sign-in service the admin configures: Google, GitHub or a generic OIDC provider (issuer, client ID, client secret). |
| **Linked sign-in** | An account's link to one identity at one SSO provider (provider + subject). Created only by accepting an invitation through that provider, or by a signed-in account choosing **Link** in its settings. |
| **Session** | One signed-in browser. It can be listed and signed out in **Settings → Sessions**. A session is `pending second factor` until the second factor is passed, then `active`. |
| **Recent sign-in** | A session that proved the password or a factor in the last 10 minutes. Sensitive actions ask for it again (see the threat model). |

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
| **Share link** | A link the admin creates for a file or a folder, which anyone holding it can open without an account. It may have a **link password** and an **expiry**, and can be revoked. A folder link lets the holder browse and download inside that folder only. |
| **Audit event** | One record in the **audit log**: who did what, to what, when, from where, and whether it worked. |
| **Settings** | Instance-wide options the admin sets in the admin interface: SMTP, SSO providers, "Require two-step sign-in", session timeouts, quotas, upload limits, audit-log retention. Bootstrap options that must be known before the database opens live in the config file instead (see [deployment.md](deployment.md#config-secrets-and-data)). |

## The two interfaces after one login

- One sign-in page at `/sign-in`, for both roles. After the second factor, the
  server answers with the account's role. The SPA routes the admin to `/admin`
  and a user to `/files`.
- Both interfaces live in one SPA build, as two lazy route trees, so a user's
  browser never downloads the admin interface's code.
- Separation is enforced **on the server**: every `/api/v1/admin/*` route's
  contract requires the `admin` role, and a contract test fails if one does
  not (see rule 5 under [Server modules](#server-modules)). User routes are scoped to the caller's home
  by the files module, never by a path the client sends. The SPA split is for
  the user's convenience, not for security.
- Shared screens: `/sign-in`, `/invitation/:token` (create account),
  `/reset/:token`, `/settings/*` (each account's own profile, password, second
  factors, linked sign-ins, sessions). The public share page `/s/:token` needs
  no account.

| Admin interface (`/admin`) | User interface (`/files`) |
|---|---|
| Files: every resource, browse, upload, download, delete, create share link | Files: own home only, browse, upload, download, delete |
| Share links: list, edit expiry/password, revoke | – |
| Users: list, quota, disable, delete, issue password reset link, remove second factors | – |
| Invitations: create, list, revoke | – |
| Resources: add/edit/remove local folder or SMB share, test, choose home root | – |
| Settings: SMTP, SSO providers, security policy, limits, retention | – |
| Audit log: filter and read | – |

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
   file), the files module's upload staging store and the resources module's
   mount-request writer, all outside every resource (lint rule in
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
| 0 | `platform` | config loading (zod), database handle and migrations, logger, clock, `secrets` (AES-GCM envelope), `rate-limits`, problem+json errors, request context (IP, caller) | – |
| 1 | `audit` | `audit_events`; `record(event)`; retention purge job | platform |
| 1 | `mail` | SMTP settings (encrypted password), `send(template, to)` | platform |
| 1 | `settings` | `settings` table: typed instance settings | platform |
| 1 | `storage` | `resolveInResource()` / `ContainedPath`, safe open, list, stat, delete, move-into-place | platform (no other module) |
| 2 | `accounts` | `accounts`, password hashing, first admin, disable/delete | platform, audit, settings |
| 3 | `sessions` | `sessions`, cookie handling, the guard hook that enforces each contract's requirements, revoking sessions | platform, audit, accounts |
| 3 | `second-factors` | `totp_factors`, `email_codes`, `recovery_codes`, `passkeys` | platform, audit, mail, accounts |
| 3 | `sso` | `sso_providers`, `linked_sign_ins`; OIDC/GitHub flows | platform, audit, accounts, settings |
| 3 | `invitations` | `invitations`, `password_reset_links` | platform, audit, mail, accounts, settings |
| 3 | `resources` | `resources`, home root, homes, SMB mount control (talks to the mount helper) | platform, audit, settings, storage |
| 4 | `sign-in` | the sign-in flow across password, passkey, SSO and second factor; enumeration-safe answers; per-account failure counters | accounts, sessions, second-factors, sso, invitations, audit |
| 4 | `files` | browse, Range downloads, delete, tus uploads (`uploads` table, staging, quotas, cleanup job) | resources, storage, audit, settings |
| 5 | `share-links` | `share_links`, `share_link_unlocks`, public share page API | files, storage, resources, accounts, audit |

`storage` sits on its own so its correctness can be proven alone. It knows
nothing about accounts or roles: callers pass it a resource root (or a home)
and a relative path, and it returns a `ContainedPath` or throws.

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
  home, resolved on the server).
- **Download.** `GET …/content?path=` with Range support. Always sent as
  `Content-Disposition: attachment`.
- **Delete.** `DELETE …/entries?path=`. Deleting a folder needs
  `recursive=true`, and the UI confirms it.
- **Upload.** `POST /api/v1/uploads` (tus creation) with `Upload-Metadata`
  giving the target (`resourceId` or `home`), the folder path and the file name.
  The server checks the target, name, size and quota **at creation** and again
  at completion. Chunks go to `/var/lib/not-unreachable/uploads/<uploadId>`. On
  completion the file is copied into a temporary name in the target folder
  (`.nu-upload-<uploadId>`), `fsync`ed, then renamed to the final name, so no
  half-written file ever appears under its real name. An existing file with
  the same name is never overwritten silently: the client asks **Replace** or
  **Keep both** (`name (1).ext`) first.

## Main tables

All ids are UUIDv7 (time-ordered) text. All times are UTC ISO-8601 text.
Columns marked 🔒 hold `secrets` envelopes (see the threat model). Columns
marked # hold SHA-256 hashes, never the token itself.

| Table | Key columns |
|---|---|
| `accounts` | id, username (unique), email, display_name, role (`admin`/`user`), status, password_hash (nullable), quota_bytes, require_second_factor, created_at, disabled_at |
| `sessions` | id, token_hash #, account_id, state (`pending_second_factor`/`active`), created_at, last_seen_at, recent_sign_in_at, ip, user_agent, revoked_at |
| `totp_factors` | id, account_id, secret 🔒, last_used_step, created_at |
| `email_codes` | id, account_id, session_id, code_hash #, expires_at, attempts, used_at |
| `recovery_codes` | id, account_id, code_hash (argon2id), used_at |
| `passkeys` | id, account_id, credential_id, public_key, counter, transports, name, created_at, last_used_at |
| `sso_providers` | id, kind (`google`/`github`/`oidc`), name, issuer, client_id, client_secret 🔒, enabled |
| `linked_sign_ins` | id, account_id, provider_id, subject, email_at_link, created_at; unique (provider_id, subject) |
| `invitations` | id, token_hash #, email, created_by, expires_at, accepted_account_id, revoked_at |
| `password_reset_links` | id, token_hash #, account_id, created_by, expires_at, used_at, revoked_at |
| `resources` | id, name, kind (`local`/`smb`), local_path, smb_host, smb_share, smb_username, smb_password 🔒, smb_domain, smb_options, is_home_root, home_root_subpath, created_at |
| `uploads` | id, account_id, target_resource_id, target_path, file_name, size, offset, staged_path, created_at, expires_at, completed_at |
| `share_links` | id, token_hash #, token 🔒 (so the admin can copy it again), resource_id, path, kind (`file`/`folder`), password_hash (nullable), expires_at (nullable), created_by, created_at, revoked_at, download_count, last_used_at |
| `share_link_unlocks` | id, share_link_id, unlock_hash #, expires_at |
| `sign_in_failures` | account_id, failures, locked_until, last_failure_at |
| `settings` | key, value (JSON, validated by its zod schema), updated_at, updated_by |
| `audit_events` | id, at, actor_kind, actor_account_id, action, target_kind, target_id, outcome, ip, user_agent, details (JSON) |

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
