# Design system

NotUnreachable's UI is built on the NotNullSoft Admin design system: its tokens,
components, layout patterns and writing rules. It carries NotUnreachable's own
name and logo, and no NotNullSoft name or logo remains anywhere in the product.
This file decides how the design system comes into the repo, what is renamed or
removed, how its use is enforced, and which parts each screen uses.

## The source, as read

The Initiative's attachment *NotNullSoft Admin Design System (2).zip*
(Attachment 361e738d-e96d-48fe-aec2-4d164d7ed3c2), 273 files. What matters here:

| In the zip | What it is |
|---|---|
| `tokens.json` → `tokens.css` | Every token, light and dark (`[data-theme="dark"]` remaps the aliases). Names carry **no brand prefix**: ramps (`--gray-50…950`, `--ember-*`, `--green-*`, `--amber-*`, `--red-*`, `--blue-*`, `--flare-*`, `--teal-500`, `--violet-500`), aliases (`--bg`, `--surface`, `--surface-raised`, `--surface-sunken`, `--surface-hover`, `--surface-selected`, `--fg-1/2/3`, `--fg-disabled`, `--border`, `--border-subtle`, `--border-strong`, `--accent*`, `--primary*`, `--success/warning/danger/info` + `-subtle/-fg/-border`), `--space-*` (4px base), `--control-*`, `--row-*`, layout sizes, `--radius-xs…full`, `--text-2xs…5xl`, `--text-<role>` font shorthands, `--shadow-0…3`, `--focus-ring`, `--duration-*`, `--ease-*`, `--z-*`, `--font-sans` (Geist), `--font-mono` (Geist Mono), `--font-logo` (Darker Grotesque). |
| `components/bundle.css` | Radius roles (`--radius-control/card/dialog/badge`), `--type-*` font shorthands, base element rules. |
| `components/<group>/*.jsx` + `components/<Name>/<Name>.d.ts`, `README.md`, `preview.html` | 41 React components (list below): minified JSX, **styled with inline style objects**, hover and press tracked in React state, and keyframes injected through a `<style>` element (`@keyframes nns-spin`). |
| `components/core/Icon.jsx` | Lucide loaded as a UMD script **from unpkg.com** at runtime. |
| `components/core/Logo.jsx`, `assets/logo/*.svg` | The NotNullSoft mark (a bar over a dot) and the two-tone lowercase "notnullsoft" wordmark in Darker Grotesque, with a product chip. |
| `fonts/` | Geist and Geist Mono (variable woff2), Darker Grotesque Medium (logo only); all SIL OFL. |
| `README.md` | Content rules (voice, casing, buttons, confirmations, toasts, empty states, numbers, time), visual foundations, iconography, layout. |
| `ui_kits/admin/` | Reference screens: Login, Shell, Users, User detail, Audit log, Settings, Dashboard. |

Not in the zip: `_adherence.oxlintrc.json` and the token-to-Tailwind mapping.
They live in notnullsoft-admin (`design-system/` and its web app), which this
Task could not read. The rules and the mapping below are therefore defined
here on their own merits. The skeleton Task compares them with that config and
brings over any rule it has that this file lacks (see [Enforcement](#enforcement)).

## How it comes into the repo

- **Decision.** The workspace package `packages/design-system`
  (`@not-unreachable/design-system`), made **once** from the zip. Tokens,
  fonts and writing rules are **copied and rebranded**. Components are
  **ported**: rewritten in TypeScript with Tailwind semantic classes, keeping
  each component's name, props (from its `.d.ts`) and look (from its `.jsx`
  and `preview.html`). From then on the package is NotUnreachable's own code,
  changed here and never pulled again from the source.
- **Reasons.**
  - *A copy, not a link:* no NotNullSoft name may remain, and a dependency or
    submodule would bring it back on every update. The two products will drift
    apart.
  - *Ported components, not copied:* the source components can't run under
    our CSP (see the threat model, T4). They inject `<style>` elements (blocked
    by `style-src 'self'`) and load Lucide from unpkg (blocked by
    `script-src 'self'`, and a supply-chain risk). They are untyped, minified
    JSX, which `strict` TypeScript and review can't work with. Their hover and
    press states run on React state instead of CSS, which costs a re-render
    per mouse move and breaks with keyboards. The ports keep the API and the
    pixels, and fix those things.
  - *A package of its own* gives the lint rules a hard line between "the design
    system, where tokens are defined" and "screens, where only tokens are used".
- **Rejected.** *Copying the `.jsx` files as they are*: breaks the CSP.
  *Loading `components/bundle.js`*: a global (`window.NotNullSoftAdminDesignSystem_a508e9`)
  that carries the name and can't be tree-shaken or type-checked. *An npm
  package or submodule from notnullsoft-admin*: brings the name and couples
  releases. *Files inside `apps/web/src`*: no boundary for the lint rules.
- **Provenance** (source attachment, date of the copy) is recorded in this file
  only, so the package itself carries no NotNullSoft name.

### Package layout

```
packages/design-system/
├─ package.json            "name": "@not-unreachable/design-system"
├─ README.md               the source README, rebranded: content rules, visual foundations, iconography, layout
├─ tokens/tokens.json      the token source (copied, comments rebranded, two accessibility fixes below)
├─ scripts/build-tokens.ts generates src/tokens.css and src/theme.css from tokens.json
├─ src/
│  ├─ tokens.css           generated: CSS custom properties, light + dark; the only file with raw values
│  ├─ theme.css            generated: Tailwind 4 @theme mapping + type utilities + keyframes + base rules
│  ├─ fonts/               Geist-Variable.woff2, GeistMono-Variable.woff2, OFL.txt
│  ├─ components/          one folder per component: <Name>.tsx, <Name>.test.tsx, index.ts
│  ├─ layouts/             AppShell, AuthLayout, PublicLayout
│  ├─ brand/               Logo, Wordmark, logo-mark.svg, favicon.svg (placeholders)
│  └─ index.ts             the public entry point
└─ lint/
   ├─ adherence.oxlintrc.json
   └─ plugin/              the `nu-design-system` oxlint JS plugin
```

`exports`: `"."`, `"./tokens.css"`, `"./theme.css"`,
`"./lint/adherence.oxlintrc.json"`. Nothing else can be imported from outside.

### Tokens → Tailwind

Token names stay **exactly as in the source**: they carry no brand, and keeping
them means the source README and `.d.ts` comments still read true. Some of them
clash with Tailwind 4's theme namespaces (`--radius-*`, `--text-*`, `--font-*`,
`--shadow-*`), and `--text-link` is a colour inside Tailwind's font-size
namespace. So `theme.css` is **generated**, not hand-written, and maps as follows:

| Source tokens | `@theme inline` | Classes in screens |
|---|---|---|
| Aliases only (`--bg`, `--surface*`, `--fg-*`, `--border*`, `--accent*`, `--primary*`, status sets, `--sidebar-*`, `--overlay`) | `--color-*: initial;` then `--color-surface: var(--surface)`, `--color-fg-1: var(--fg-1)`, `--color-border-strong: var(--border-strong)` … | `bg-surface`, `text-fg-2`, `border-border-subtle`, `bg-danger-subtle text-danger-fg` |
| Ramps (`--gray-*`, `--ember-*` …) | **not exposed** (as the source README says: "use through the semantic aliases") | – |
| `--space-1` = 4px base | `--spacing: var(--space-1)` | `p-5` = 20px, `gap-2` = 8px, `p-1.5` = 6px, matching `--space-*` one for one |
| `--control-*`, `--row-*`, `--sidebar-width`, `--topbar-height`, `--page-padding`, `--card-padding`, `--content-max` | `--spacing-control-md: var(--control-md)`, `--spacing-row: var(--row-default)`, `--spacing-sidebar: …`, `--spacing-page: …`, `--container-content: var(--content-max)` | `h-control-md`, `h-row`, `w-sidebar`, `p-page`, `max-w-content` |
| Radius roles from `bundle.css` | `--radius-*: initial;` then `--radius-control/card/dialog/badge/full` | `rounded-control`, `rounded-card`, `rounded-dialog` |
| `--shadow-1/2/3`, `--focus-ring` | `--shadow-*: initial;` then `--shadow-control: var(--shadow-1)`, `--shadow-raised`, `--shadow-floating`, `--shadow-focus` | `shadow-control`, `shadow-floating`, `focus-visible:shadow-focus` |
| `--text-2xs…5xl`, `--type-*` / `--text-<role>` shorthands | `--text-*: initial;` font sizes are not exposed as classes; each role is an `@utility` | `type-page-title`, `type-section-title`, `type-card-title`, `type-body`, `type-body-sm`, `type-label`, `type-caption`, `type-overline`, `type-mono`, `type-metric` |
| `--font-sans`, `--font-mono` | emitted inside `@theme` by the generator (with the stack from tokens.json), so `font-sans` / `font-mono` work | `font-mono` for ids, codes, timestamps |
| `--duration-*`, `--ease-*`, `--z-*` | `--ease-*: initial; --ease-out: …`; `--animate-spin`; durations and z-index as `@utility` | `duration-fast`, `ease-out`, `z-modal` |

`@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));` keeps
the source's theme switch. A snapshot test over the generator's output catches
a token that maps to nothing.

`apps/web/src/main.css` is the web app's only CSS file:

```css
@import "@not-unreachable/design-system/theme.css";
@source "../../../packages/design-system/src";
```

### Two accessibility fixes in the copy

The source notes two values below WCAG and keeps them. NotUnreachable fixes them
in `tokens.json`, the only value changes:

| Token | Source | Ours | Why |
|---|---|---|---|
| Accent button fill (`--accent` where it sits behind `--fg-on-accent`) | ember-500 `#f23d0f`, white text 3.85:1 | a new `--accent-fill: var(--ember-600)` (`#cc2f07`, about 5.3:1), hover ember-700; `--accent` stays ember-500 for focus, icons and tints | 13px button labels need 4.5:1 (WCAG 1.4.3). |
| Input border | `--border-strong` (gray-200, 1.5:1) | a new `--border-control`: gray-400 light, gray-500 dark (about 3.3–3.5:1) | An input's boundary needs 3:1 (WCAG 1.4.11). Secondary buttons keep `--border-strong`: their label identifies them. |

## What is renamed or removed

| In the source | In NotUnreachable |
|---|---|
| `assets/logo/*` (mark, wordmark, horizontal logo, app icons, favicon, all tones) | **Removed.** Replaced by `brand/` (below). |
| `Logo` / `Mark` components (the bar-and-dot mark, the two-tone "notnullsoft" wordmark, the `product` chip) | **Replaced** by `Logo` (mark + wordmark) and `Wordmark`, same props minus `product`. |
| `--font-logo`, `--text-logo`, `.logo`, `fonts/DarkerGrotesque-*` | **Removed**: they exist only for the NotNullSoft wordmark. |
| "NotNullSoft", "NotNullSoft Admin", "back office", "staff" in the README, token comments, `.d.ts` docs, previews | "NotUnreachable", or rewritten where the sentence was about NotNullSoft. The README's "Write the company as NotNullSoft; the wordmark is always lowercase" is deleted. |
| `window.NotNullSoftAdminDesignSystem_a508e9`, `components/bundle.js`, `components/index.d.ts` | **Removed**: the package's ES exports replace them. |
| `nns-` identifiers (`@keyframes nns-spin`) | `nu-` (`--animate-spin` / `@keyframes nu-spin` in `theme.css`). |
| `ui_kits/admin/*` (sample data with `@notnullsoft.com` emails, "Restricted to NotNullSoft staff") | **Not copied.** The patterns are used (see the screen map); the files are not. |
| `archived/`, `_ds_manifest.json`, `manifest.json`, `assets/notes/*` (tooling files of the export) | **Not copied.** |
| Charts (`LineChart`, `BarChart`, `DonutChart`, `Sparkline`) and `StatCard` | **Not ported now**: no screen in this Initiative needs them. Port them when one does. |
| Token names and values, components, layouts, content rules | **Kept**, apart from the two accessibility fixes above. Ember stays the accent. |

**Check that nothing is left.** A CI step (owned by the skeleton Task) fails the
build if this case-insensitive pattern matches any file, or file name, under
`apps/`, `packages/` or `deploy/`:

```
notnullsoft|not[-_ ]null[-_ ]soft|\bnns[-_]|nnsoft
```

`docs/design/` is excluded: it has to name the source. The pattern is
deliberately not just `notnull`, which would hit Drizzle's `.notNull()`.

## NotUnreachable's name and logo

- **Name:** "NotUnreachable", one word, capital N and U, in copy and in
  `<title>`.
- **Wordmark:** `<Wordmark />` renders the name as live text in Geist
  semibold, `tracking-tight`, `text-fg-1`. *Rejected:* a two-tone lowercase
  wordmark in Darker Grotesque, which would read as NotNullSoft's brand.
- **Logo: a placeholder for now.** `brand/logo-mark.svg` is the lucide
  `waypoints` glyph in `--accent` on a `rounded-control` square of
  `--surface-sunken`. `brand/favicon.svg` is derived from it. Both carry a
  `PLACEHOLDER` comment. `<Logo />` (mark + wordmark; `variant="mark"` for the
  collapsed sidebar, as in the source) is the only way screens show the brand,
  so a real logo later changes `brand/` and nothing else. A designed logo is a
  later Task (see the [task map](README.md#task-map)).

## Enforcement

Screens style only through the design system's components and its semantic
classes. Raw values live in `tokens.json` / the generated CSS and nowhere else.

**Scope.** The rules apply to `apps/web/src/**`, through `overrides` in the
root `.oxlintrc.json`, and to `packages/design-system/src/components/**` and
`layouts/**`. Only the generated `tokens.css` and `theme.css` hold raw values.

**The rules.** They live in `packages/design-system/lint/adherence.oxlintrc.json`,
which the root config `extends`. All are errors.

| Rule | Catches | Example rejected |
|---|---|---|
| `nu-design-system/no-arbitrary-values` | Tailwind arbitrary values and properties in `className` and in strings passed to `cn()` / `clsx()` / `cva()` | `w-[13px]`, `bg-[#0af]`, `text-[15px]`, `font-['Inter']`, `[mask-type:luminance]` |
| `nu-design-system/no-raw-style-values` | Hex colours, `rgb()/hsl()/oklch()`, lengths with units (`px`, `rem`, `em`, `vh` …) and font-family names in any string or template literal | `fg: '#fff'` (as in the source Button), `` `0 ${px}px` `` |
| `nu-design-system/no-inline-style` | The `style` prop, except objects whose keys are all CSS custom properties | `style={{ marginTop: 8 }}`; allowed: `style={{ "--progress": pct }}` |
| `nu-design-system/no-style-element` | `<style>` in JSX (also blocked by the CSP) | `<style>{"@keyframes …"}</style>` |
| `nu-design-system/no-unknown-classes` | Class names Tailwind doesn't generate from our theme, including the default palette that the reset removed | `text-gray-500`, `shadow-lg`, `rounded-xl` |
| `no-restricted-imports`: internals | Deep imports into the package | `@not-unreachable/design-system/src/components/button/…` |
| `no-restricted-imports`: other kits | Icon sets other than `lucide-react`, other UI kits, CDN globals | `react-icons`, `@heroicons/react`, `@mui/*` |
| `no-restricted-imports`: CSS | `.css` imports in `apps/web/src` other than `main.css` | `import "./file-list.css"` |
| `react/no-danger` | `dangerouslySetInnerHTML` (also a security rule, T4) | – |

The `nu-design-system` rules form a small oxlint JS plugin, each with a test
file of rejected and accepted cases. Where `_adherence.oxlintrc.json` in
notnullsoft-admin already has a built-in rule for a row, the skeleton Task uses
that rule and drops the plugin rule. Any of its rules this table lacks is
added, renamed to `nu-`.

**Icons** come from `lucide-react` through the ported `Icon` component (stroke
1.75, sizes 14 / 16 / 20, `currentColor`), never from a CDN.

**A missing component** is added to `packages/design-system` and never styled
ad hoc in a screen. A lint rule can't catch "should have been a component", so
review checks it.

## Components and layouts per screen

**Ported from the source** (the first Task that needs each one ports it; the
skeleton Task ports the shell and the forms):
Button, IconButton, Badge, Tag, Avatar, Card, Icon, Logo; Input + Field,
Textarea, Select, Checkbox, Radio + RadioGroup, Switch, SegmentedControl;
Sidebar, Topbar, PageHeader, Breadcrumbs, Tabs, Pagination; DataTable,
DescriptionList, Timeline, ProgressBar; Dialog, Drawer, Menu, Tooltip; Toast,
Alert, EmptyState, Skeleton.

**New, built from the same tokens** (not in the source): `PasswordInput`
(Input + reveal IconButton in `suffix`), `CodeInput` (6 boxes, paste-aware),
`CopyField` (read-only mono Input + copy IconButton + "Copied" Toast),
`DropZone` (full-page overlay while files are dragged), `UploadQueue` (Card of
rows with ProgressBar and pause/resume/cancel IconButtons), `QuotaMeter`
(ProgressBar + "4.2 / 10 GB" caption), `QrCodePanel`, `ExpiryPicker`
(SegmentedControl presets "1 day / 7 days / 30 days / Custom" + a native
`datetime-local` Input).

**Layouts**, after the source's patterns:

- **AuthLayout**, from `ui_kits/admin/Login.jsx`: centred 380px column on
  `bg`, Logo above, form Card at `rounded-dialog shadow-raised p-7`, caption
  below. The accent button is the screen's one ember-filled moment.
- **AppShell**, from `Shell.jsx`: Sidebar 240px (56px collapsed) + 56px sticky
  Topbar (breadcrumbs, theme switch, account Menu), content to 1440px with
  `p-page`; each page opens with PageHeader (title, description, actions, tabs).
  A user's sidebar has a single item, **Files**, so for users the shell hides
  the sidebar and puts the item in the Topbar.
- **PublicLayout**: Topbar with the Logo only, for the share page.

| Screen | Interface | Layout | Components | Source pattern |
|---|---|---|---|---|
| Sign-in | both | AuthLayout | Input (lg), PasswordInput, Button `accent` lg full width, "or" divider, Button `secondary` per SSO provider and "Sign in with a passkey" (Icon `key-round`), Alert for errors | Login |
| Second factor | both | AuthLayout | SegmentedControl (Authenticator app / Email code / Passkey), CodeInput, Button, link "Use a recovery code" | Login |
| First-run setup, invitation, password reset | both | AuthLayout | Field, Input, PasswordInput with hint, QrCodePanel, recovery codes in `type-mono` with CopyField and "Download codes" | Login |
| Files | both | AppShell | PageHeader with actions (Upload files, New folder), Breadcrumbs for the path, DataTable (name with file-type Icon, size `num` right-aligned, modified relative time, row Menu: Download, Share link (admin), Delete), EmptyState, DropZone, Dialog to confirm delete ("Delete 3 files?") | Users |
| Upload queue | both | AppShell | UploadQueue docked bottom-right, Toast "Upload complete" | – |
| Create / edit share link | admin | Dialog | Switch "Require a password", PasswordInput, ExpiryPicker, Alert `warning` for "No expiry", CopyField | UserDetail (suspend Dialog) |
| Share links | admin | AppShell | DataTable (item, Badge expiry, Badge password, downloads `num`, created), Tag filters (Active / Expired / Revoked), row Menu (Copy link, Edit, Revoke) | Users |
| Users | admin | AppShell | Tabs (Users / Invitations), DataTable with Avatar, Badge status, QuotaMeter, row Menu (Disable, Reset password, Remove second factors, Delete), Dialog confirms | Users |
| User detail | admin | AppShell, 2:1 | PageHeader with status + actions, DescriptionList, QuotaMeter, Timeline of the user's audit events | UserDetail |
| Invitations | admin | AppShell (tab of Users) | DataTable, Badge (Pending / Accepted / Expired / Revoked), Dialog "Invite user" → CopyField | Users |
| Resources | admin | AppShell | DataTable or Card list with Badge (Available / Unavailable + reason), Drawer form for local folder / SMB share, Button "Test connection" → Alert result, RadioGroup "Home root" | Settings |
| Admin settings | admin | AppShell | Tabs (General / Security / Email / Sign-in providers), label-left/controls-right rows, Switch, Input with unit `suffix`, Select, sticky "unsaved changes" bar | Settings |
| Account settings | both | AppShell | Tabs (Profile / Password / Two-step sign-in / Linked sign-ins / Sessions), label-left rows, DataTable of sessions, Dialog confirms | Settings |
| Audit log | admin | AppShell | Filters (date range, actor, action, outcome Tag), day-grouped Timeline, "Details" opens a Drawer with the event as DescriptionList, Pagination, Button "Export CSV"; the timezone is stated | AuditLog |
| Public share page | public | PublicLayout | Card with name, size and expiry, PasswordInput + Button when protected, Button "Download", DataTable for a folder link, Alert "This link is not valid" | Login |

**Wording** follows the source README's content rules unchanged: sentence
case; buttons are verb + object ("Create share link", "Revoke link"); a confirm
title is a question naming the object, and its body says the consequence; toasts
are past tense ("Link revoked"); empty states say why and what to do; times are
relative in lists and absolute in details and the audit log; no emoji, no
exclamation marks.

## Owners

- **Skeleton** (Task 94776ed7-0244-4ba0-bd52-a6cfbac33271): the package, the
  token generator and both CSS files, fonts, the brand placeholders, the three
  layouts, the forms and shell components, the lint config and plugin, the
  brand check.
- Each feature Task: its screens above, and the components it is the first to
  need, ported or built into the package.
