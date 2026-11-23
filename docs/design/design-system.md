# Design system

NotUnreachable's UI is built on the NotNullSoft Admin design system: its tokens,
components and layout patterns. It carries NotUnreachable's own name and logo,
and no NotNullSoft name or logo remains anywhere in the product. This file
decides how the design system comes into the repo, what is renamed or removed,
how its use is enforced, and which parts each screen uses.

**Sources.** The Initiative's attachment *NotNullSoft Admin Design System (2).zip*
(Attachment 361e738d-e96d-48fe-aec2-4d164d7ed3c2) and `design-system/` in the
notnullsoft-admin repo (`readme`, `styles.css`, `_adherence.oxlintrc.json`),
plus how `apps/admin-panel/web` there maps the tokens to Tailwind and lints its
screens. Where the two differ, the zip wins: it is the version the Initiative
names.

> **Source check pending.** These sources could not be opened while this design
> was written: the zip can't be read as text here, and the notnullsoft-admin
> checkout was not readable from this Task. The decisions below don't depend
> on the exact file contents. The token prefix, the component names in the
> [screen map](#components-and-layouts-per-screen) and the exact rule list in
> [Enforcement](#enforcement) are written from the Plan's description of the
> source, and are checked against the files before this Task's Gate.

## How it comes into the repo

- **Decision.** A **one-time rebranded copy**, kept as the workspace package
  `packages/design-system` (`@not-unreachable/design-system`). The skeleton
  Task copies it in once, renames it as below, and commits it. From then on it
  is NotUnreachable's own code; changes are made here, not pulled from
  notnullsoft-admin.
- **Reasons.** The product must carry no NotNullSoft name, and a live link to
  notnullsoft-admin (a dependency, a submodule) would bring the name with it on
  every update. NotUnreachable and NotNullSoft Admin are separate products that
  will drift; a copy lets each change without breaking the other. A package of
  its own, rather than a folder inside `apps/web`, gives the lint rules a hard
  line between "the design system, where raw values live" and "screens, where
  they may not".
- **Rejected.** *An npm package published from notnullsoft-admin*: brings the
  name and couples the two release cycles. *A git submodule or subtree*: same
  coupling, and every pull would need re-renaming. *Copying the files into
  `apps/web/src`*: no package boundary for the lint rules to rely on.
- **Provenance** is recorded in this file only (source, attachment id, date of
  the copy), not inside the package, so the package itself carries no
  NotNullSoft name.

### Package layout

```
packages/design-system/
├─ package.json            "name": "@not-unreachable/design-system", "exports" below
├─ README.md               the design system's readme, rebranded (usage rules, do/don't)
├─ src/
│  ├─ tokens.css           the only file with raw values: colours, spacing, radii, shadows,
│  │                       type scale, motion, as CSS custom properties (light + dark)
│  ├─ theme.css            Tailwind 4 `@theme` mapping tokens to semantic utilities
│  ├─ fonts/               self-hosted font files (woff2) + @font-face, no CDN (CSP font-src 'self')
│  ├─ components/          React components, one folder each, `index.ts` re-exports
│  ├─ layouts/             AppShell, AuthLayout, PublicLayout
│  ├─ brand/               NotUnreachable logo (placeholder), wordmark, favicon
│  └─ index.ts             the public entry point
└─ lint/
   ├─ adherence.oxlintrc.json   the adherence config, carried over and renamed
   └─ plugin/                   the `nu-design-system` oxlint JS plugin (rules below)
```

`exports`: `"."` (components, layouts, brand), `"./tokens.css"`,
`"./theme.css"`, `"./lint/adherence.oxlintrc.json"`. Nothing else can be
imported from outside the package.

### Tokens → Tailwind

`theme.css` follows the same mapping as notnullsoft-admin's web app: it imports
`tokens.css`, **resets Tailwind's defaults**, then declares only the semantic
tokens.

```css
@import "tailwindcss";
@import "./tokens.css";

@theme {
  --color-*: initial;     /* no slate-500, red-600 … only semantic colours exist */
  --font-*: initial;
  --text-*: initial;
  --radius-*: initial;
  --shadow-*: initial;

  --color-surface: var(--nu-color-surface);
  --color-surface-raised: var(--nu-color-surface-raised);
  --color-fg: var(--nu-color-fg);
  --color-fg-muted: var(--nu-color-fg-muted);
  --color-accent: var(--nu-color-accent);
  --color-danger: var(--nu-color-danger);
  /* … one line per semantic token in tokens.css … */
  --spacing: var(--nu-space-unit);
  --font-sans: var(--nu-font-sans);
  --font-mono: var(--nu-font-mono);
}
```

So `bg-surface`, `text-fg-muted`, `rounded-md`, `p-4` exist, and `bg-red-500`
does not, because the reset removed the palette. `apps/web/src/main.css` is the
web app's only CSS file:

```css
@import "@not-unreachable/design-system/theme.css";
@source "../../../packages/design-system/src";
```

## What is renamed or removed

| In the source | In NotUnreachable |
|---|---|
| The NotNullSoft wordmark, logo, logo mark, favicon, app icons | **Removed.** Replaced by `brand/` (below). |
| "NotNullSoft", "NotNullSoft Admin" in copy, page titles, `<title>`, meta tags, alt text, readme | "NotUnreachable", or removed where the sentence was about NotNullSoft. |
| Identifiers derived from the name: CSS custom-property prefix (e.g. `--nns-…`), class prefixes, `data-` attributes, TypeScript names, package names, storage keys | Prefix `nu` (`--nu-color-accent`, `@not-unreachable/design-system`). |
| Sample screens, sample data, screenshots and illustrations that show NotNullSoft products or customers | **Removed.** The readme's examples are rewritten with NotUnreachable screens (file list, sign-in). |
| Fonts | **Kept** if their licence allows redistribution (OFL or similar); self-hosted. A font licensed only to NotNullSoft is replaced with the nearest OFL face, and the swap is noted in the package readme. |
| Token **values** (colours, spacing, type scale, radii, shadows) | **Kept** as they are. NotUnreachable's identity comes from its name and logo, not from a new palette. |
| Components, layouts, interaction patterns | **Kept**, renamed only where the name carries the brand. |

**Check that nothing is left.** A CI step (owned by the skeleton Task) fails the
build if this case-insensitive pattern matches any file under `apps/`,
`packages/` or `deploy/`, or any file name there:

```
notnullsoft|not[-_ ]null[-_ ]soft|\bnns[-_]|nnsoft
```

`docs/design/` is excluded: it has to name the source. The pattern is
deliberately not just `notnull`, which would hit Drizzle's `.notNull()`.

## NotUnreachable's name and logo

- **Name:** "NotUnreachable", one word, capital N and U. The wordmark is the
  name set in the design system's display font and weight, in `--nu-color-fg`.
  `<Wordmark />` renders it as text, so no font is outlined into an image.
- **Logo: a placeholder for now.** `brand/logo-mark.svg` is a simple mark (a
  lucide `waypoints` glyph in `--nu-color-accent` on a rounded square in
  `--nu-color-surface-raised`), with `brand/favicon.svg` derived from it. Both
  files say `PLACEHOLDER` in a comment. `<Logo />` and `<Wordmark />` are the
  only way screens show the brand, so swapping in a real logo changes the files
  in `brand/` and nothing else. A designed logo is a separate, later Task (see
  the [task map](README.md#task-map)).

## Enforcement

Screens may style only through the design system's components and its
semantic Tailwind classes. Raw values live in `tokens.css` and nowhere else.

**Where the rules apply.** `apps/web/src/**` (every screen and feature
component), through `overrides` in the root `.oxlintrc.json`. Inside
`packages/design-system/src/**` the same rules apply to components, and only
`tokens.css` may hold raw values.

**From the adherence config.** `_adherence.oxlintrc.json` comes over as
`packages/design-system/lint/adherence.oxlintrc.json`, renamed as above, and
the root config `extends` it. Its rules stay errors, not warnings.

**The rules, in force on screens:**

| Rule | Catches | Example rejected |
|---|---|---|
| `nu-design-system/no-arbitrary-values` | Tailwind arbitrary values and properties in `className`, `cn()`, `cva()`, `clsx()`, `tv()` and template literals passed to them | `w-[13px]`, `bg-[#0af]`, `text-[15px]`, `font-['Inter']`, `[mask-type:luminance]` |
| `nu-design-system/no-raw-style-values` | Hex colours, `rgb()/hsl()/oklch()`, lengths with units (`px`, `rem`, `em`, `vh`…) and font-family names in any string or template literal under `apps/web/src` | `const red = "#e11d48"`, `` `${n}px` `` |
| `nu-design-system/no-inline-style` | The `style` prop, except objects whose keys are all CSS custom properties (`style={{ "--nu-progress": pct }}`) | `style={{ marginTop: 8 }}` |
| `nu-design-system/no-palette-classes` | Tailwind default palette and scale classes that the theme reset removed (they would silently do nothing) | `text-gray-500`, `shadow-lg` when not a token |
| `no-restricted-imports` (design-system internals) | Deep imports into the package and direct imports of the primitives it wraps | `@not-unreachable/design-system/src/components/button/…`, the headless primitive library itself |
| `no-restricted-imports` (other UI kits and icon sets) | Any icon set other than lucide; other component libraries | `react-icons`, `@heroicons/react`, `@mui/*` |
| `no-restricted-imports` (CSS) | Importing `.css` from anywhere in `apps/web/src` except `main.css` | `import "./file-list.css"` |
| `react/no-danger` | `dangerouslySetInnerHTML` (also a security rule, T4) | – |

The `nu-design-system` rules are a small oxlint JS plugin in
`packages/design-system/lint/plugin`, each with a test file of rejected and
accepted cases (Vitest, using oxlint's rule tester). If the adherence config
already covers a row above with a built-in rule, the built-in rule is used and
the plugin rule is not written.

**Missing component?** It is added to `packages/design-system` (with its own
story in the readme), never styled ad hoc in a screen. A lint rule can't catch
"should have been a component", so review checks it.

## Components and layouts per screen

Layouts:

- **AuthLayout**: centred card on `surface`, logo and wordmark above. Used for
  sign-in, setup, invitation, password reset, second factor.
- **AppShell**: sidebar navigation + top bar (account menu, sign-out) + content
  area with `PageHeader`. The admin and the user each get their own navigation;
  the user's has a single item, **Files**, so the shell collapses the sidebar
  into the top bar.
- **PublicLayout**: top bar with the logo only, for the share page.

| Screen | Interface | Layout | Main components |
|---|---|---|---|
| Sign-in | both | AuthLayout | Form field, Text input, Password input, Button, Divider ("or"), SSO buttons (Button with provider icon), Passkey button, Inline alert |
| Second factor | both | AuthLayout | Code input (6 digits), Tabs or segmented control (authenticator / email / passkey / recovery code), Link button |
| First-run setup, invitation, password reset | both | AuthLayout | Stepper, Form field, Password input with strength hint, QR code panel, Recovery-code list with Copy and Download |
| Files (browser) | both | AppShell | Breadcrumbs, Toolbar (Upload, New folder, Delete), Data table (name with file-type icon, size, modified, actions menu), Empty state, Dropdown menu, Confirm dialog, Drop zone overlay |
| Upload queue | both | AppShell (docked panel) | Progress bar, list rows with Pause / Resume / Cancel icon buttons, Toast on completion or failure |
| Create / edit share link | admin | Dialog | Form field, Switch (Password), Password input, Date-time picker (Expiry) with presets, Copy field, Inline alert ("No expiry") |
| Share links | admin | AppShell | Data table (item, expiry badge, password badge, downloads, created), Filter bar, Status badge, Row actions |
| Users | admin | AppShell | Data table, Status badge, Quota meter, Row actions (Disable, Reset password, Remove second factors, Delete), Confirm dialog |
| Invitations | admin | AppShell | Data table, Status badge (pending / accepted / expired / revoked), Dialog to create, Copy field |
| Resources | admin | AppShell | Card list or Data table with Status badge (available / unavailable + reason), Dialog or page form for local folder / SMB share, "Test connection" Button with Inline alert result, Radio "Home root" |
| Admin settings (SMTP, SSO providers, security, limits, retention) | admin | AppShell | Tabs or sub-navigation, Section card, Form field, Switch, Number input with unit, Select, Save bar |
| Account settings (profile, password, second factors, linked sign-ins, sessions) | both | AppShell | Section card, Description list, Data table (sessions), Button, Confirm dialog |
| Audit log | admin | AppShell | Filter bar (date range, actor, action, outcome), Data table with cursor Pagination, Outcome badge, Detail drawer (JSON shown as a description list), Export button |
| Public share page | public | PublicLayout | Card with item name, size and expiry, Password input + Button (when protected), Download button, Data table (folder link), Inline alert (invalid or expired) |

Components above that the source design system turns out not to have (likely:
Code input, Drop zone, Upload queue, Quota meter, Copy field, QR code panel)
are added to `packages/design-system` by the first Task that needs them, built
from the existing tokens and primitives.

## Owners

- **Skeleton** (Task 94776ed7-0244-4ba0-bd52-a6cfbac33271): the copy and rename,
  `tokens.css`/`theme.css`, the layouts, the lint config and plugin, the
  no-NotNullSoft CI check, the placeholder brand.
- Each feature Task: the screens in its row above, and any missing component it
  needs, added to the package.
