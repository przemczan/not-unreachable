# NotUnreachable design

NotUnreachable is a self-hosted, multi-user file-sharing app, safe to expose
to the Internet. One **admin** maps local folders and SMB shares as
**resources**, browses and manages all of them, and hands out **share links**.
Invited **users** each get a **home** folder, and see nothing else. Sign-in is
local or through SSO, with a second factor (authenticator app, email codes or
passkeys) and recovery codes. Uploads are chunked and resumable; downloads
resume through HTTP Range.

This folder is the design every later Task builds on. Each decision is written
as **decision → reasons → alternatives rejected**.

## Overview

```
Browser ──HTTPS──▶ Caddy / nginx ──HTTP 127.0.0.1:8480──▶ not-unreachable (Node 24, Fastify 5)
                                                           ├─ /api/v1/*      REST + tus, contracts from packages/contracts
                                                           ├─ /*             the React SPA (admin + user interfaces, share page)
                                                           ├─ SQLite (WAL)   /var/lib/not-unreachable/db
                                                           ├─ local folders  allowed through ReadWritePaths
                                                           └─ SMB shares     kernel cifs mounts, made by a root helper via polkit
```

- **One process, one origin.** The Fastify server serves both the API and the
  SPA, behind a TLS reverse proxy. It runs as an unprivileged, heavily
  sandboxed systemd service.
- **TypeScript monorepo** (pnpm): `apps/server`, `apps/web`,
  `packages/contracts` (zod schemas shared by both sides),
  `packages/design-system` (the rebranded NotNullSoft Admin design system).
- **One login, two interfaces.** One sign-in page; the admin lands in
  `/admin`, a user in `/files`. The server enforces roles on every route.
- **One path-safety function.** Every file access goes through
  `resolveInResource()`, which rejects traversal, symlinks and special files
  and re-checks the opened descriptor.
- **Secrets outside the database.** SMB passwords, TOTP secrets and SSO/SMTP
  secrets are AES-256-GCM encrypted with a master key the service gets from
  systemd `LoadCredential=`.
- **SMB through the kernel.** No maintained Node SMB client speaks SMB 3.1.1
  with encryption. A small root helper, which the service may start only for
  its own mount units, mounts shares with fixed, safe options.

## Parts

| Part | What it decides |
|---|---|
| [stack.md](stack.md) | Each piece of the stack confirmed or replaced (Node 22 → 24), versions, password hashing, TOTP, email, migrations, how the SPA is served, package layout |
| [design-system.md](design-system.md) | How the NotNullSoft Admin design system comes in as `@not-unreachable/design-system`, what is renamed or removed, the placeholder logo, the lint rules that enforce token-only styling, components per screen |
| [domain.md](domain.md) | Glossary in the UI's words, the admin/user split, server modules and their dependency direction, path safety, uploads, main tables, API style |
| [threat-model.md](threat-model.md) | Assets, trust boundaries, attackers, and threats T1–T15, each with a testable mitigation and its owner Task |
| [smb.md](smb.md) | OS mounts vs a userspace client, the choice, privileges, and how the admin adds a share at runtime |
| [deployment.md](deployment.md) | systemd unit and hardening, TLS behind Caddy or nginx, trusted proxies, config/secret/data paths, first admin, backups |

## Commands

The skeleton Task (Task 94776ed7-0244-4ba0-bd52-a6cfbac33271) **creates** these
scripts in the root `package.json`. Once it has landed, set them on the
Project's page:

| Project setting | Command |
|---|---|
| Install | `pnpm install --frozen-lockfile` |
| Build | `pnpm build` |
| Lint | `pnpm lint && pnpm typecheck && pnpm format:check` |
| Test | `pnpm test` |
| Install inputs | `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `package.json`, `apps/*/package.json`, `packages/*/package.json`, `.nvmrc`, `.npmrc` |

What each root script runs:

| Script | Runs |
|---|---|
| `pnpm build` | `pnpm -r build`: contracts and design-system (`tsc -b`), web (`vite build`), server (`tsc -b`, then copies `apps/web/dist`) |
| `pnpm lint` | `oxlint --type-aware` (with the design-system adherence rules) and the brand check (no NotNullSoft names) |
| `pnpm typecheck` | `tsc -b --noEmit` over the project references |
| `pnpm format:check` | `prettier --check .` |
| `pnpm test` | `vitest run` across the workspace (unit and integration, no browser) |
| `pnpm test:e2e` | `playwright test` against the built server. It needs Playwright's browsers, so it runs in CI and is not part of the Project's Test command. |
| `pnpm test:smb` | the SMB integration job against a Samba container; it needs root and a container runtime, so it runs only in CI. |

## Task map

The Initiative's Tasks checked against this design. **These are
recommendations only; this Task changes no other Task.**

| Task | Owns in this design | Recommendation |
|---|---|---|
| [Project skeleton](/tasks/94776ed7-0244-4ba0-bd52-a6cfbac33271) | Monorepo, `contracts`, the `platform` module (config, DB + migrations at startup, logger with redaction, `secrets` envelope + master-key loading, problem+json), `settings` module, the security baseline (headers, CSP, CSRF origin check + `X-NU-Request`, global rate limit, body limits, `https` check), `sd_notify`, CLI scaffold (`migrate`, `backup`, `rotate-key`), CI with `pnpm audit` | **Split out the design system** into its own Task, "Design system package: rebranded copy, theme and lint rules": the copy, rename, brand check, oxlint plugin and the three layouts. That is a review of its own, and the skeleton is already large. Both can start right after this Task. |
| [Local accounts and sessions](/tasks/cff653c2-aafd-4202-bf5d-1e78458708a8) | `accounts`, `sessions`, `sign-in`, `audit` modules; first-run setup and `setup-link`; `reset-admin`; recent sign-in; sign-in failure counters (T1, T2, T11, T12); account settings: profile, password, sessions; the **Audit log** screen | Add the audit-log **screen** and its retention job explicitly; today the Task says only "an audit log of security events". The first-run setup cannot require a second factor yet; the 2FA Task adds that. |
| [Invitations and user management](/tasks/4723ccf9-fc28-4532-a186-8f099f09903e) | `invitations` module; invitation page; Users and Invitations screens; quotas per user | **Add admin-issued password reset links**: nothing in the Initiative covers a user who forgot their password. **Make it wait for the Resources Task too**, or move home creation into that Task: it creates homes, which needs the home root. |
| [Two-factor authentication](/tasks/378c8142-5b80-4646-bd76-3455d34a1da1) | `second-factors` (TOTP, email codes, recovery codes), `mail` module and SMTP settings, the `pending second factor` session state and guard, "Require two-step sign-in" (on for the admin by default), the admin's "Remove second factors" action, security notice emails (T10) | Add the `mail` module and the SMTP settings screen explicitly; other Tasks (invitations, lockout notices) reuse it. Add forcing the admin to enrol at the next sign-in, which closes the gap left by first-run setup. |
| [Passkeys](/tasks/520bfe57-4e16-448c-87ba-916a6e9ace9e) | Passkey registration, passkey as second factor, passwordless sign-in | **Make it wait for the 2FA Task**: a passkey as second factor plugs into the pending-session step that Task builds. |
| [Mapped resources](/tasks/397cb6b6-e258-4e8d-8143-3ac08e74230a) | `storage` (path safety, T5), `resources` module, home root and homes, local folders (`allow-folder`), SMB shares with the mount helper, polkit rule and the request/result protocol (T6, T14) | **Consider splitting SMB off** into "SMB shares: mount helper and admin screens". The privileged helper deserves its own review, and local folders + path safety can land first and unblock Files sooner. |
| [Single sign-on](/tasks/7bd5a230-b9f0-4679-aac9-fbc0909fe528) | `sso` module, providers screen, linked sign-ins, invitation-by-SSO (T9) | Also wait for the 2FA Task, so an SSO sign-in goes through the second-factor step from day one (T9). |
| [Files](/tasks/65765533-4396-4ae9-a6da-6780c2b84a29) | `files` module: browse, Range downloads, delete, tus uploads, staging, quotas, cleanup jobs (T7); the file browser and upload queue in both interfaces | No change. The upload queue, drop zone and quota meter components go into the design-system package. |
| [Share links](/tasks/ccb26ec8-a7f9-46fa-8d98-c9f55fa4d4a1) | `share-links` module, unlocks, the public share page, its rate limits and audit events (T8) | No change. |
| [Linux install script](/tasks/1e20d309-2836-46ce-be58-757b7307d1f2) | Everything in [deployment.md](deployment.md): service user, paths, master key, unit + hardening (exposure ≤ 2.0), `cifs-utils`, helper unit, polkit rule, the mount-propagation test, backup timer, Caddy/nginx docs, the setup link | No change, but its acceptance should include the `systemd-analyze security` check and the propagation test. |
| [Security review](/tasks/f1f3aa6d-0023-4448-bbe0-cefb832cb17b) | Checking T1–T15 against the built app and OWASP ASVS 5.0 level 2; the residual-risk register | Use the threat model's **Test** column as its checklist. |
| *(missing)* | A designed NotUnreachable logo to replace the placeholder | **Add a small design Task** before the first release; only `packages/design-system/src/brand/` changes. |

Dependency changes recommended above, in short: Invitations → also waits for
Resources; Passkeys → waits for 2FA; SSO → also waits for 2FA; plus the two
optional splits (Design system package; SMB shares).

## Out of scope

Self-update, and share links restricted to specific users (later Initiatives).
Self-service password reset by email. A Docker image.
