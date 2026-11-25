# NotUnreachable design

NotUnreachable is a self-hosted, multi-user file-sharing app, safe to expose
to the Internet. One **admin** maps local folders and SMB shares as
**resources**, browses and manages all of them, and hands out **share links**.
Invited **users** each get a **home** folder, and see nothing else. The admin
signs in with a password, set at first run through a one-time setup link and
reset only from the server's command line; users will sign in through SSO. Sessions are
server-side, and every security event goes to an **audit log** the admin reads.
Later Tasks add a second factor (authenticator app or passkeys)
and recovery codes. Uploads are chunked and resumable; downloads
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
  `/admin` (Audit log, Settings), a user in `/files`. The server enforces roles on every route.
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
| [../security/review.md](../security/review.md) | The security review: scope and method, findings with CVSS 4.0 and their regression tests, the T1–T15 checklist, ZAP scans and probes, the supply chain, and the full ASVS 5.0 L2 table |

## Commands

The [skeleton Task](/tasks/94776ed7-0244-4ba0-bd52-a6cfbac33271) **creates**
these scripts in the root `package.json`. Once it has landed, set them on the
Project's page. The page has Install, Build, Lint and Test; typecheck and the
format check run inside Lint, as in the Office's other TypeScript Projects.

| Project setting | Command |
|---|---|
| Install | `pnpm install --frozen-lockfile` |
| Build | `pnpm build` |
| Lint | `pnpm lint && pnpm typecheck && pnpm format:check` |
| Test | `pnpm test` |
| Install inputs | `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `package.json`, `apps/*/package.json`, `packages/*/package.json`, `deploy/mount-helper/package.json`, `.nvmrc`, `.npmrc` |

What each root script runs:

| Script | Runs |
|---|---|
| `pnpm build` | `pnpm -r build`: contracts and design-system (`tsc -b`), web (`vite build`), server (`tsc -b`, then copies `apps/web/dist`), and the mount helper (`deploy/mount-helper`, bundled into one `.mjs` file) |
| `pnpm lint` | `oxlint --type-aware` (with the design-system adherence rules) and the brand check (no NotNullSoft names) |
| `pnpm typecheck` | `tsc -b` over the project references; it emits only declarations, into each package's git-ignored `.tsbuild/` (TypeScript 7 refuses `--noEmit` with references) |
| `pnpm format:check` | `prettier --check .` |
| `pnpm test` | `vitest run` across the workspace (unit and integration, no browser) |
| `pnpm test:e2e` | `playwright test` against the built server. It needs Playwright's browsers, so it runs in CI and is not part of the Project's Test command. |
| `pnpm test:helper-root` | the mount helper's tests against hostile request files (`deploy/mount-helper/test-root/`). They need root, so they run only in the CI job `mount-helper-root`. |
| `pnpm test:smb` | the SMB integration test (`apps/server/src/**/*.smb.test.ts`): add share, upload, Range download, delete, remove share against a Samba container that requires SMB 3.1.1 with encryption, through the installed helper, unit and polkit rule. It needs root, the `cifs` kernel module and a container runtime, so it runs only in the CI job `smb`. |

## Task map

The Initiative's Tasks checked against this design. **These are
recommendations only; this Task changes no other Task.**

| Task | Owns in this design | Recommendation |
|---|---|---|
| [Project skeleton](/tasks/94776ed7-0244-4ba0-bd52-a6cfbac33271) | Monorepo, `contracts`, the `platform` module (config, DB + migrations at startup, logger with redaction, `secrets` envelope + master-key loading, problem+json), `settings` module, the security baseline (headers, CSP, CSRF origin check + `X-NU-Request`, global rate limit, body limits, `https` check), `sd_notify`, CLI scaffold (`migrate`, `backup`, `rotate-key`), CI with `pnpm audit` | **Split out the design system** into its own Task, "Design system package: rebranded copy, theme and lint rules": the copy, rename, brand check, oxlint plugin and the three layouts. That is a review of its own, and the skeleton is already large. Both can start right after this Task. |
| [Local accounts and sessions](/tasks/cff653c2-aafd-4202-bf5d-1e78458708a8) | `accounts`, `sessions`, `sign-in`, `audit` modules; first-run setup and `setup-link`; `reset-admin`; recent sign-in; sign-in failure counters (T1, T2, T11, T12); account settings: profile, password, sessions; the **Audit log** screen | Add the audit-log **screen** and its retention job explicitly; today the Task says only "an audit log of security events". The first-run setup cannot require a second factor yet; the 2FA Task adds that. |
| [Invitations and user management](/tasks/4723ccf9-fc28-4532-a186-8f099f09903e) | `invitations` and `mail` modules; SMTP settings and the Email tab; invitations (single use, copyable, resendable, revocable); invitation page (account, linked sign-in and home created through SSO); **re-link links** for a user who lost their provider account; Users and Invitations screens (disable, quota, unlink, remove); security notices by email | Users have no password, so there are no password reset links; re-link links cover a lost provider account. It waits for the Resources Task too: it creates homes, which needs the home root. |
| [Two-factor authentication](/tasks/378c8142-5b80-4646-bd76-3455d34a1da1) | `second-factors` (TOTP, recovery codes; the admin always needs a factor), the `pending second factor` session state and guard, enrolment at the admin's first sign-in, `reset-admin --second-factors`, security notices (T10; emailed once the Invitations Task's `mail` module has SMTP set) | Add forcing the admin to enrol at the next sign-in, which closes the gap left by first-run setup. The `mail` module and SMTP settings belong to the Invitations Task. |
| [Passkeys](/tasks/520bfe57-4e16-448c-87ba-916a6e9ace9e) | Passkey registration, passkey as second factor, passwordless sign-in | **Make it wait for the 2FA Task**: a passkey as second factor plugs into the pending-session step that Task builds. |
| [Mapped resources](/tasks/397cb6b6-e258-4e8d-8143-3ac08e74230a) | `storage` (path safety, T5), `resources` module, home root and homes, local folders (`allow-folder`), SMB shares with the mount helper (TypeScript, run as root by systemd), polkit rule and the request file and exit-code protocol (T6, T14) | **Consider splitting SMB off** into "SMB shares: mount helper and admin screens". The privileged helper deserves its own review, and local folders + path safety can land first and unblock Files sooner. |
| [Single sign-on](/tasks/7bd5a230-b9f0-4679-aac9-fbc0909fe528) | `sso` module, providers screen, linked sign-ins, invitation-by-SSO (T9) | Also wait for the 2FA Task, so an SSO sign-in goes through the second-factor step from day one (T9). |
| [Files](/tasks/65765533-4396-4ae9-a6da-6780c2b84a29) | `files` module: browse, Range downloads, delete, tus uploads, staging, quotas, cleanup jobs (T7); the file browser and upload queue in both interfaces | No change. The upload queue, drop zone and quota meter components go into the design-system package. |
| [Share links](/tasks/ccb26ec8-a7f9-46fa-8d98-c9f55fa4d4a1) | `share-links` module, unlocks, the public share page, its rate limits and audit events (T8) | No change. |
| [Linux install script](/tasks/1e20d309-2836-46ce-be58-757b7307d1f2) | Everything in [deployment.md](deployment.md): `deploy/install.sh` (preflight, `cifs-utils`, polkit, Node 24 from NodeSource with vendored keys; service user, paths, master key made once, `config.env`, allowed folders; releases in `/opt/not-unreachable/<version>` with `current`, upgrade and rollback; exposure ≤ 2.0 and the mode audit; `--uninstall`, `--purge`), the CLI wrapper, the service, backup and helper units, polkit rule, sysusers and tmpfiles entries, Caddy/nginx examples (`deploy/proxy/`), the setup link; the release tarball, SBOM and `SHA256SUMS` ([stack.md](stack.md#release-artefact)); [docs/install.md](../install.md); the tests in `deploy/install/` and the CI workflow Install with the mount-propagation test ([smb.md](smb.md#mount-propagation-and-the-hardened-service)) | Done as recommended: the `systemd-analyze security` check and the propagation test are part of it. The propagation test runs on Ubuntu 24.04 and AlmaLinux 9 (SELinux enforcing); the shared-bind fallback `.mount` unit is not shipped unless it fails there. |
| [Security review](/tasks/f1f3aa6d-0023-4448-bbe0-cefb832cb17b) | Checking T1–T15 against the built app and OWASP ASVS 5.0 level 2; the residual-risk register | Done: [docs/security/review.md](../security/review.md) (every T1–T15 row and ASVS L1/L2 requirement with its result and evidence, ZAP scans), 12 findings fixed with regression tests (1 High, 2 Medium), and the threat model's [residual risk register](threat-model.md#residual-risk-register), whose proposed and open entries wait for the user. |
| *(missing)* | A designed NotUnreachable logo to replace the placeholder | **Add a small design Task** before the first release; only `packages/design-system/src/brand/` changes. |

Dependency changes recommended above, in short: Invitations → also waits for
Resources; Passkeys → waits for 2FA; SSO → also waits for 2FA; plus the two
optional splits (Design system package; SMB shares).

## Out of scope

Self-update, and share links restricted to specific users (later Initiatives).
Self-service password reset by email. A Docker image.
