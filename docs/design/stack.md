# Stack

Every decision reads **decision → reasons → alternatives rejected**. The proposed
starting point was Node 22 LTS, Fastify, SQLite through Drizzle, React 19 + Vite +
Tailwind 4 (lucide icons) in a pnpm monorepo, @simplewebauthn, openid-client and
tus. One piece is replaced (Node 22 → Node 24). The rest is kept, and the gaps
(driver, hashing, TOTP, mail, validation, routing, tests, lint) are filled in.

## Version policy

- The **line** in the table below is the decision. The skeleton Task installs
  the newest patch of that line, saves exact versions (`save-exact=true` in
  `.npmrc`) and commits `pnpm-lock.yaml`. From then on the lockfile pins every version.
- A new major is a decision of its own, made in a Task of its own. Renovate (see
  [Supply chain](threat-model.md#t13-security-headers-and-supply-chain)) raises
  each one as its own pull request.
- If a line listed here was superseded before the skeleton Task starts (this
  design was written in November 2026), the skeleton Task may take the newer
  major. It records the change in this file, in the same pull request.

## Decisions at a glance

| Concern | Decision | Line |
|---|---|---|
| Runtime | Node.js LTS | **24.x** (replaces 22) |
| Package manager / monorepo | pnpm workspaces | 10.x |
| Language | TypeScript, `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` | 5.9.x |
| HTTP server | Fastify | 5.x |
| Database | SQLite (WAL) through **better-sqlite3** | 12.x |
| Data access / migrations | drizzle-orm + drizzle-kit | 0.44.x / 0.31.x |
| Schemas and contracts | zod, wired into Fastify with fastify-type-provider-zod | 4.x / 6.x |
| Web UI | React | 19.x |
| Build (web) | Vite | 7.x |
| Styling | Tailwind CSS (CSS-first `@theme`) | 4.1.x |
| Icons | lucide-react | exact 0.x pin |
| Routing (web) | React Router (data mode) | 7.x |
| Server state (web) | TanStack Query | 5.x |
| Password hash | argon2id through **@node-rs/argon2** | 2.x |
| TOTP | **otpauth** | 9.x |
| Passkeys | @simplewebauthn/server + /browser | 13.x |
| SSO | openid-client | 6.x |
| Email | **nodemailer** over SMTP | 7.x |
| Resumable uploads | @tus/server + @tus/file-store, tus-js-client | 2.x / 4.x |
| Logging | pino (Fastify's logger) | the line Fastify 5 depends on |
| Lint | **oxlint** (+ type-aware rules) | 1.x |
| Format | Prettier | 3.x |
| Unit / integration tests | Vitest | 4.x |
| End-to-end tests | Playwright | 1.x |

## Runtime: Node.js 24 LTS, replacing Node 22

- **Decision.** Node.js 24.x LTS, set as `"engines": { "node": ">=24.11 <25" }`
  and in `.nvmrc`. The install script installs Node 24 from NodeSource or the
  distribution and refuses to install on any other major.
- **Reasons.** Node 22 leaves support in April 2027, a few months after this app's
  first release, so its first upgrade would be forced right away. Node 24 is
  maintained until April 2028 and has had a year of LTS fixes. It brings
  `URLPattern`, a newer V8 and an updated `undici`. Native modules
  (better-sqlite3, @node-rs/argon2) ship prebuilt binaries for it on linux-x64
  and linux-arm64 (glibc and musl), so installing compiles nothing.
- **Rejected.** *Node 22*: support ends too soon. *Node 26*: the newest LTS line;
  we move to it in a later Task once its native-module prebuilds and our
  dependencies have caught up. We plan that upgrade before Node 24 ends in April
  2028. *Bun / Deno*: their Node compatibility is good but not complete for
  better-sqlite3, @tus/server and openid-client's runtime checks. A
  security-focused, Internet-facing app should run on the runtime its
  dependencies are tested on.

## Package manager and monorepo: pnpm workspaces

- **Decision.** pnpm 10.x, pinned through the `packageManager` field (Corepack).
  The layout is shown under [Package layout](#package-layout).
- **Reasons.** Strict `node_modules`: a package can import only what it
  declares, which keeps module boundaries honest. Workspaces with
  `workspace:*` links. Since pnpm 10, dependency lifecycle scripts are blocked
  by default and allowed one by one (`onlyBuiltDependencies`).
  `minimumReleaseAge` delays brand-new releases. Both are supply-chain controls
  (see the threat model).
- **Rejected.** *npm workspaces*: hoisting lets phantom dependencies through, and
  install scripts run by default. *Nx / Turborepo*: the repo has four packages,
  and pnpm's `--filter` with `-r` covers the task graph without another tool.

## HTTP server: Fastify 5

- **Decision.** Fastify 5.x with only these official plugins: `@fastify/cookie`,
  `@fastify/helmet`, `@fastify/rate-limit`, `@fastify/static`. Request bodies
  are capped by Fastify's `bodyLimit` (default 1 MiB; upload chunks go through
  tus with their own limit).
- **Reasons.** Schema-first routes, encapsulated plugins (a natural fit for the
  module boundaries in [domain.md](domain.md)), `inject()` for fast HTTP tests
  without a socket, pino logging with redaction built in, and an exact
  `trustProxy` setting. tus and Range downloads need raw request and response
  access, which Fastify gives through `request.raw`, `reply.raw` and
  `reply.hijack()`.
- **Rejected.** *Express 5*: no schema-first routing, and a weaker plugin
  boundary. *Hono*: good on edge runtimes, but its Node adapter adds a layer
  over raw streams that tus and Range need. *NestJS*: decorators and DI are
  heavy for an app this size. notnullsoft-admin uses Nest, but no server code
  is shared, so matching it buys nothing.

## Database: SQLite in WAL mode through better-sqlite3

- **Decision.** One SQLite file, `/var/lib/not-unreachable/db/not-unreachable.sqlite`,
  opened with better-sqlite3 12.x. PRAGMAs at open: `journal_mode=WAL`,
  `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`,
  `secure_delete=ON`.
- **Reasons.** One admin and a handful of users: SQLite's single-writer model is
  far beyond the load, and one file makes backups trivial (`VACUUM INTO`, see
  [deployment.md](deployment.md#backups)). better-sqlite3 is synchronous, which
  makes transactions plain function calls. It is the most widely used Node
  SQLite driver and a first-class Drizzle driver. `secure_delete` overwrites
  deleted rows, such as revoked session hashes and old secrets.
- **Rejected.** *`node:sqlite`*: built in, but still marked as in active
  development in Node 24, and Drizzle's support for it is newer than for
  better-sqlite3. Revisit it together with the Node 26 upgrade. *libSQL / Turso*:
  replication we don't need. *PostgreSQL*: a second service to install, secure
  and back up, for no gain at this scale.

## Data access and migrations: Drizzle

- **Decision.** drizzle-orm 0.44.x for queries; drizzle-kit 0.31.x (dev only)
  generates SQL migration files into `apps/server/drizzle/`, which are
  committed and reviewed like code.
  **How migrations run:** the server applies pending migrations at startup,
  before it listens, with `migrate()` from `drizzle-orm/better-sqlite3/migrator`.
  Before it applies any, it writes a backup
  (`VACUUM INTO '/var/lib/not-unreachable/backups/pre-migration-<timestamp>.sqlite'`).
  If a migration fails, the process exits non-zero. systemd then stops
  restarting it (see `StartLimitBurst` in the unit) and the old database stays
  intact next to the backup. A `not-unreachable migrate` CLI subcommand runs
  the same step on its own, for the install script.
- **Reasons.** The schema in TypeScript gives typed queries with no codegen
  step. Plain SQL migration files are easy to review. Migrating at startup means
  there is only one way to run them, and one process (the service) owns the
  database file.
- **Rejected.** *`drizzle-kit push`*: no reviewable history, so never in
  production. *Prisma*: a separate query engine binary and heavier generated
  client. *Kysely*: a fine query builder, but it has no schema-to-migration
  generator.

## Schemas and the contracts package: zod 4

- **Decision.** `packages/contracts` holds the zod 4 schemas of every API
  request and response, and the route table (method, path, schemas). The server
  validates and serialises with them through `fastify-type-provider-zod`. The
  web app's typed API client is built from the same route table.
- **Reasons.** One source of truth for the wire format. Both sides are checked
  by the type checker, and the server rejects anything that doesn't parse,
  including unknown keys (`z.strictObject`). zod also validates the web
  forms, so a form and its API call share one rule.
- **Rejected.** *TypeBox*: faster through Fastify's native Ajv, but the speed
  gain is irrelevant at this load and its form-validation story is weaker.
  *OpenAPI-first with codegen*: an extra generated layer. An OpenAPI document can
  still be produced from the zod schemas later if needed.

## Web UI: React 19 + Vite 7 + Tailwind 4 + lucide-react

- **Decision.** Kept as proposed. React 19.x, Vite 7.x, Tailwind 4.1.x through
  `@tailwindcss/vite`, `lucide-react` pinned exactly (it is still on 0.x).
  Routing: React Router 7 in data mode. Server state: TanStack Query 5.
  No component library other than our design-system package
  (see [design-system.md](design-system.md)).
- **Reasons.** The NotNullSoft Admin design system is React with lucide icons,
  and its tokens are CSS custom properties that map onto Tailwind 4 `@theme`
  variables. So its tokens come over as they are, and its components port to
  this stack prop for prop (they are rewritten with Tailwind classes to meet our
  CSP; see [design-system.md](design-system.md#how-it-comes-into-the-repo)). React Router's lazy
  routes split the admin and user interfaces into separate chunks. TanStack
  Query handles caching, retries and invalidation after uploads and deletes.
- **Rejected.** *Next.js / Remix SSR*: a server-rendering runtime we don't need
  for an app behind a login. It would also weaken the strict CSP (inline
  hydration data). *TanStack Router*: a good choice too, but React Router has
  the wider reach and no codegen step. *Redux / Zustand*: there is almost no
  client-only state; TanStack Query covers the server state.

## How the SPA is served: by the API process, same origin

- **Decision.** The production build of `apps/web` is copied into the server
  bundle and served by Fastify through `@fastify/static`, with an SPA fallback
  for non-`/api` paths. Hashed assets get
  `Cache-Control: public, max-age=31536000, immutable`; `index.html` gets
  `no-cache`. In development, Vite's dev server proxies `/api` to the server.
- **Reasons.** One origin: the session cookie can be `__Host-` and
  `SameSite=Strict`, there is no CORS, and CSRF origin checks compare against
  one value. There is one process to install, harden and update, and the reverse
  proxy forwards everything to one port. Security headers (CSP and others) are
  set in one place.
- **Rejected.** *Static files served by the reverse proxy*: one more place to get
  the CSP and headers right, and the proxy configuration is outside our tests.
  *A separate web origin*: needs CORS and cross-site cookies, which widens the
  CSRF surface.

## Password hashing: argon2id through @node-rs/argon2

- **Decision.** argon2id with m = 64 MiB, t = 3, p = 1, 16-byte salt, 32-byte
  output, stored as the PHC string, so parameters can rise later; the hash is
  upgraded at the next successful login. At most 4 hashes run at once (a
  semaphore), so a login flood cannot exhaust memory. The same function hashes
  share-link passwords.
- **Reasons.** argon2id is OWASP's first choice. These parameters exceed OWASP's
  minimum (19 MiB, t = 2) and take roughly 100–250 ms on a small home server.
  @node-rs/argon2 ships prebuilt Rust binaries with no install script.
- **Rejected.** *`argon2` (node-gyp)*: needs an install script or a toolchain.
  *`node:crypto` argon2*: added in Node 24.7 but experimental; adopt it when it
  is stable. *bcrypt*: weaker against GPUs, and truncates passwords at 72 bytes.
  *scrypt*: acceptable, but argon2id is the stronger default.

## TOTP: otpauth

- **Decision.** `otpauth` 9.x, RFC 6238: SHA-1, 6 digits, 30 s period (what every
  authenticator app supports), ±1 step window. The secret is 20 random bytes,
  encrypted at rest (see [secrets](threat-model.md#t6-secrets-at-rest-smb-credentials-totp-seeds-smtp-and-sso-secrets)).
  The last accepted time step is stored, so a code cannot be used twice. The QR
  code is drawn by `qrcode` 1.x as an SVG data URL, on the server.
- **Reasons.** Small, maintained, no dependencies, typed.
- **Rejected.** *speakeasy*: unmaintained. *otplib*: also fine, but larger.

## Email: nodemailer over SMTP

- **Decision.** nodemailer 7.x. The admin enters SMTP settings in the admin
  interface (host, port, TLS mode, username, password, from address); the SMTP
  password is encrypted at rest. A **Send test email** action checks them.
  Mail is used for email sign-in codes, invitations and security notices.
  TLS is required (`secure` or `requireTLS`) unless the host is a loopback address.
- **Reasons.** The de facto Node SMTP client: mature, with no dependencies.
- **Rejected.** *Provider HTTP APIs (SES, Postmark…)*: a self-hosted app
  shouldn't depend on one vendor; every provider offers SMTP.

## Passkeys: @simplewebauthn 13

- **Decision.** Kept. `@simplewebauthn/server` and `@simplewebauthn/browser`
  13.x. The RP ID is the host of `PUBLIC_ORIGIN`, and the origin check uses
  `PUBLIC_ORIGIN` exactly. User verification is `required` for passwordless
  sign-in and `preferred` when a passkey is the second factor.
- **Reasons.** The reference WebAuthn library for TypeScript, actively
  maintained, covering attestation and the signature counter.
- **Rejected.** *fido2-lib*: lower level, with less active maintenance.

## SSO: openid-client 6

- **Decision.** Kept. openid-client 6.x for Google and generic OIDC (discovery,
  authorization code with PKCE S256, `state`, `nonce`, ID token checks). GitHub
  is OAuth 2 rather than OIDC: the same library runs the code + PKCE flow, then
  the account is read from `GET /user` and its verified emails from
  `GET /user/emails`. The stable GitHub **numeric user id** is the subject.
- **Reasons.** Certified OpenID relying party, by the author of `jose`; it has
  no dependencies beyond `jose` and `oauth4webapi`.
- **Rejected.** *passport*: callback-style and session-coupled; its strategies
  vary in quality. *Auth.js*: built for Next.js and its own session model.

## Resumable uploads: tus

- **Decision.** Kept. Server: `@tus/server` 2.x with `@tus/file-store`, mounted at
  `/api/v1/uploads` through a raw-body route. Client: `tus-js-client` 4.x behind
  our own design-system components (no Uppy). Chunks are written to a staging
  directory on the local data disk. Only when the upload is complete is the
  file moved into the target resource, through the path-safety layer (see
  [domain.md](domain.md#files-and-uploads)).
- **Reasons.** An open, documented protocol with resume, and server and client
  libraries maintained by the protocol's authors. Staging locally keeps
  half-finished uploads out of users' folders and SMB shares, and gives one
  place to enforce quotas and clean up.
- **Rejected.** *Our own chunk protocol*: reinvents tus, with no resume
  semantics others have tested. *Multipart form upload*: no resume.
  *Uppy*: it brings its own UI, which would bypass the design system.
  *S3 multipart semantics*: there is no S3 here.

## Downloads: HTTP Range, served by the app

- **Decision.** Our own handler streams files with `fs.createReadStream` from an
  open file descriptor (see path safety), supporting single `Range: bytes=`
  requests (206), `If-Range` with a strong ETag (inode + size + mtime) and
  `Accept-Ranges: bytes`. Multi-range requests are answered with the full body
  (200), which RFC 9110 allows.
- **Reasons.** `@fastify/static`'s `send` serves only from a fixed root by path,
  and would bypass the open-file-descriptor containment check. The handler is
  about 100 lines and fully testable.
- **Rejected.** *`X-Accel-Redirect` / `X-Sendfile` to the proxy*: ties us to one
  proxy and moves the access check out of our code.

## Logging: pino

- **Decision.** Fastify's built-in pino (not a direct dependency, so it can't
  drift from Fastify's), JSON to stdout (journald). Redacted
  paths: `req.headers.cookie`, `req.headers.authorization`,
  `res.headers["set-cookie"]`, and every body field named `password`,
  `code`, `secret` or `token`. Share-link tokens are cut out of logged URLs,
  both the share page and the public share API
  (`/s/<redacted>`, `/api/v1/public/share-links/<redacted>/…`).
- **Reasons.** Already in Fastify, fast, structured; journald keeps it rotated.
- **Rejected.** *winston*: slower, and adds nothing here.

## Lint, format, typecheck

- **Decision.** **oxlint** 1.x with the `typescript`, `react`, `react-hooks`,
  `jsx-a11y`, `import` and `unicorn` plugins, plus the design-system adherence
  rules (see [design-system.md](design-system.md#enforcement)). Type-aware rules
  through `oxlint --type-aware` (`no-floating-promises`,
  `no-misused-promises`). Prettier 3 formats. `tsc -b` checks types across the
  project references.
- **Reasons.** notnullsoft-admin enforces its design system with an oxlint
  config (`_adherence.oxlintrc.json`), so its rules can carry over without
  being translated. oxlint is fast enough to run on save and in CI on every
  push. Its JS plugin API is ESLint-compatible, so the few design-system rules
  of our own are ordinary ESLint-style rule files (see
  [design-system.md](design-system.md#enforcement) for the fallback if that API
  isn't stable in the line the skeleton installs).
- **Rejected.** *ESLint 9*: would mean translating the adherence config and
  running a second, slower linter. *Biome*: its lint rule set and plugin
  system don't cover the adherence rules.

## Tests

- **Decision.** Vitest 4.x for unit and integration tests. Server tests use
  `fastify.inject()` against an in-memory SQLite database and a temporary
  directory as a local-folder resource. The path-safety layer has its own
  table-driven tests: traversal strings, symlinks, FIFOs, a TOCTOU swap.
  Playwright 1.x runs the end-to-end flows (first-run admin setup, login with
  2FA, upload/resume, share link) against the built server. The SMB code path
  is tested against a Samba container in CI (see [smb.md](smb.md#testing)).
- **Rejected.** *Jest*: slower ESM and TS support. *Cypress*: Playwright covers
  several browsers and passkey testing (virtual authenticators) better.

## Package layout

```
not-unreachable/
├─ apps/
│  ├─ server/              @not-unreachable/server – Fastify app, CLI, migrations
│  │  ├─ src/modules/…     one folder per module (see domain.md)
│  │  ├─ src/cli.ts        `not-unreachable` CLI: migrate, setup-link, reset-admin, rotate-key, backup, allow-folder
│  │  └─ drizzle/          generated SQL migrations (committed)
│  └─ web/                 @not-unreachable/web – React SPA (admin + user interfaces, share page)
├─ packages/
│  ├─ contracts/           @not-unreachable/contracts – zod schemas + route table, no runtime deps beyond zod
│  ├─ design-system/       @not-unreachable/design-system – rebranded tokens, Tailwind theme, components, lint rules
│  └─ tsconfig/            shared tsconfig bases
├─ deploy/                 systemd units, polkit rule, Caddy/nginx examples, install script
│  └─ mount-helper/        the SMB mount helper: TypeScript, node: built-ins only, built into one .mjs file
├─ docs/design/            this design
└─ pnpm-workspace.yaml
```

Dependency direction: `web → contracts, design-system`; `server → contracts`;
`contracts`, `design-system` and `deploy/mount-helper` (a workspace package,
so `pnpm -r build` and the tests cover it) depend on no workspace package. `server` never
imports `web` or `design-system`; it copies `apps/web/dist` at build time.

## Release artefact

`pnpm --filter @not-unreachable/server deploy --prod dist/release` gives a
self-contained folder with the server package at its root (`dist/main.js`,
production `node_modules`, the web build, the migrations). better-sqlite3 and
@node-rs/argon2 are native, so CI builds one tarball per architecture
(`linux-x64`, `linux-arm64`, glibc), each on its own architecture. The install
script picks the one for the host and unpacks it to
`/opt/not-unreachable/<version>` and points `/opt/not-unreachable/current` at
it (see [deployment.md](deployment.md)). Self-update is out of scope for this
Initiative.
