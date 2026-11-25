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
| `api/components/*.md`, `api/tokens.md` | Reference docs: each component's props and usage, and every token with its value. The port's reference next to the `.d.ts` files. |
| `guidelines/type-*.html` | Specimen pages for the type scale, body text and numbers. |
| `ui_kits/admin/` | Reference screens: Login, Shell, Users, User detail, Audit log, Settings, Dashboard. |
| `archived/` (incl. `styles.css`, `tokens/*.css`), `components/Cover/` | An earlier split of the tokens and specimen cards, kept by the export; `tokens.json` supersedes them. The cover page shows the brand. |

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
- **Provenance** is recorded in this file only, so the package itself carries
  no NotNullSoft name. The source is the attachment above. The skeleton Task
  (or the design-system package Task, if it is split off) adds the date of the
  copy and the commit that made it here, under this heading:
  *Copied on: 2026-11-24*, by the design-system package Task
  (2684133c-9b0b-4556-b7de-d9d09c005273), whose one commit on `main` made it.
  Components were ported from the notnullsoft-admin repo's `design-system/`
  (the same files as the zip); `tokens.json`, `README.md`, `bundle.css` and
  `preview.html` come from the zip, the base rules from
  `apps/admin-panel/web/src/styles/global.css`.
- **Port decisions.**
  - `style` / `bodyStyle` / `inputStyle` props became `className` /
    `bodyClassName` / `inputClassName`. Every other prop name, type, default and
    union from the `.d.ts` is kept; additions are optional (below).
  - Variants use `cva`; `cn()` is clsx + tailwind-merge, taught the theme's
    named sizes (`px-page`, `rounded-card`, `shadow-raised` …) and the `type-*`,
    `duration-*` and `z-*` utility groups.
  - Hover, press, focus, disabled and invalid states are CSS variants, never
    React state. No component renders a `<style>`.
  - `Icon` takes `name` from a curated `icons.ts` map of `lucide-react` imports
    (tree-shaken, never a CDN), stroke 1.75, sizes 14 / 16 / 20. A screen that
    needs a new glyph adds it to the map.
  - `SidebarItem` has an optional `href` (an `<a>` with `aria-current`;
    without it, a `<button>`).
  - `Menu` and `Tooltip` use the native Popover API (`popover="manual"`), no
    portal or positioning library. Their position is passed only as `--nu-*`
    custom properties (`left-(--nu-menu-x)`); `src/lib/toCssLength.ts` is the
    one place a number becomes a length.
  - The `type-*` roles set the whole `font` shorthand, so weight and family go
    on an inner element (Button lg label, Badge, Avatar initials). Sizes with no
    role take the nearest one (Badge `sm` is 12px, not 11px).
  - Topbar is solid `bg-surface` (the source's blur has no token). The Switch
    track when off is `bg-border-control`, for the same 3:1 as inputs.
  - Input, Textarea and Select render inside `Field`, which wires the label,
    `aria-describedby` and `aria-invalid`; `useFieldControl()` lets a custom
    control join a Field. RadioGroup has `label`, `name`, `defaultValue`;
    SegmentedControl is a `radiogroup` of `radio` buttons with roving focus.
    Checkbox, Radio and Switch call `onChange(checked, event)`.
  - Each component carries its props and usage as TSDoc; the `.d.ts`,
    `.prompt.md` and `api/` files are not copied.
  - Dialog and Drawer are the native `<dialog>` opened with `showModal()`
    (focus trap, inert page, Escape as `cancel`); the caller owns `open`.
    Tabs with an `href` on every item render a `nav` of links with
    `aria-current="page"` (`renderLink` for the router's link); without, a
    WAI-ARIA `tablist` with TabPanel. Pagination is cursor-based ("Previous" /
    "Next" and a summary) instead of the source's page numbers. Timeline takes
    `groups` (a heading per day) and an `action` per item. Toast adds
    ToastProvider and `useToast()`. DataTable has no sorting, selection or
    loading rows yet, and adds `caption`.
  - Not ported yet: ProgressBar, Skeleton. The first Task that needs one ports
    it.

### Package layout

```
packages/design-system/
├─ package.json            "name": "@not-unreachable/design-system"
├─ README.md               the source README, rebranded: content rules, visual foundations, iconography, layout
├─ tokens/tokens.json      the token source (copied, comments rebranded, two accessibility fixes below)
├─ scripts/
│  ├─ build-tokens.ts      generates src/tokens.css, src/theme.css and the README's token reference;
│  │                       `--check` fails when they drift (`pnpm tokens` / `pnpm tokens:check`)
│  ├─ theme-mapping.ts     which theme variable or utility each token becomes, or why it isn't exposed
│  ├─ token-source.ts      reads tokens.json, resolves references (also for the contrast test)
│  └─ render-brand-icons.ts writes every static file in src/brand from brand/mark.ts, the tokens
│                          and Geist (`pnpm brand-icons`); its test fails when they drift
├─ src/
│  ├─ tokens.css           generated: CSS custom properties, light + dark; the only file with raw values
│  ├─ theme.css            generated: Tailwind 4 @theme mapping + type utilities + keyframes + base rules
│  ├─ fonts/               Geist-Variable.woff2, GeistMono-Variable.woff2, OFL.txt
│  ├─ components/          one folder per component: <Name>.tsx, <Name>.test.tsx, index.ts
│  ├─ layouts/             AppShell (with useTheme), AuthLayout, PublicLayout
│  ├─ brand/               Logo, Wordmark, logo-mark.svg, favicon.svg, apple-touch-icon.png,
│  │                       NOTICE.md (placeholders)
│  ├─ lib/                 cn, toCssLength
│  └─ index.ts             the public entry point
├─ test/                   setup (Popover API stub for jsdom), CSP-safe render and no-CDN tests
└─ lint/
   ├─ adherence.oxlintrc.json
   ├─ plugin/              the `nu-design-system` oxlint JS plugin, a test file per rule
   └─ fixtures/            bad-screen.tsx, which trips every rule (ignored by the main lint)
```

`exports`: `"."`, `"./tokens.css"`, `"./theme.css"`,
`"./lint/adherence.oxlintrc.json"`, and `"./brand/*.svg"` / `"./brand/*.png"`
(static files only, for `index.html`'s icon links). Nothing else can be imported
from outside. The package ships source: `"."` is `src/index.ts`, and the web
app's Vite build compiles it.

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

The block is `@theme inline reference`: utilities read the tokens' own
variables (`rounded-full` is `var(--radius-full)`), and Tailwind emits no theme
variables of its own into `:root`. Besides the table, the generator maps the
aliases the source app also used: `--surface-inverse`, `--fg-inverse`,
`--fg-on-accent`, `--border-focus`, `--control-hover`, `--control-press`, the
`--neutral-*` and `--sidebar-*` sets, and `--text-link` / `--text-link-hover`
as `--color-link` / `--color-link-hover` (`text-link`). Line heights,
letter spacing and font weights keep their names (`leading-tight`,
`tracking-caps`, `font-medium`).

`@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));` keeps
the source's theme switch. AppShell's switch sets `data-theme` on `<html>` and
remembers it in `localStorage` (`nu-theme`); without a choice it follows
`prefers-color-scheme`. The web app calls `applyInitialTheme()` before its
first render, so every layout, not only AppShell, opens in that theme without a
flash. `theme.css` also carries the base rules of the source
app's `global.css`: the default border colour, `color-scheme` per `data-theme`,
the `dialog` reset and `::backdrop`, and the `prefers-reduced-motion` switch.

Every token is either mapped or listed as not exposed with its reason
(`theme-mapping.ts` throws on one that is neither). Tests check a snapshot of
`theme.css`, that `--check` passes and catches drift, that every token of the
source's adherence list exists in `tokens.css`, and the contrast of the two
fixes below in light and dark.

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
| `archived/`, `components/Cover/`, `_ds_manifest.json`, `manifest.json`, `assets/notes/*` (tooling files and specimens of the export) | **Not copied.** |
| `api/components/*.md`, `api/tokens.md`, `guidelines/type-*.html` | **Not copied as files.** Each ported component carries its props and usage as TSDoc; the token reference is generated from `tokens.json` into the package README. |
| Charts (`LineChart`, `BarChart`, `DonutChart`, `Sparkline`) and `StatCard` | **Not ported now**: no screen in this Initiative needs them. Port them when one does. |
| Token names and values, components, layouts, content rules | **Kept**, apart from the two accessibility fixes above. Ember stays the accent. |

**Check that nothing is left.** `scripts/check-brand.ts`, the second step of
`pnpm lint` (so CI runs it), fails if this case-insensitive pattern matches the
contents or the name of any file git tracks or would track under `apps/`,
`packages/` or `deploy/` (binary files by name only):

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
- **Mark: the "nu" route.** A lowercase "nu" drawn as one unbroken route that
  climbs, dips and ends at a node: the path always gets there. It's drawn in
  `--accent` on a `rounded-control` square of `--surface-sunken`, on a 32-unit
  grid, with a 3.5-unit stroke, round caps and joins, and a node of radius 3.
  The mark is an original drawing, chosen from three concepts (bridge, route
  monogram, way out). It uses no icon-set glyph and nothing from NotNullSoft's
  bar-over-dot mark. *Rejected:* the lucide `waypoints` placeholder.
- **One drawing, many files.** `brand/mark.ts` holds the drawing. `<Logo />`
  draws it inline in `currentColor` with token classes (`text-accent`,
  `bg-surface-sunken`), so it follows the theme with no raw colours. Its
  `variant` is `horizontal` (mark and Wordmark) or `mark` (the collapsed
  sidebar). Its `tone` is `auto`, `light`, `dark`, `mono-ink` or `mono-white`;
  the mono tones drop the square. `scripts/render-brand-icons.ts`
  (`pnpm brand-icons`) writes the static files from the same drawing and
  the tokens:
  - `logo-mark.svg`, `logo-mark-dark.svg` and `logo-mark-mono.svg`
    (`currentColor`).
  - `logo-lockup.svg` and `logo-lockup-dark.svg`, for use outside the app. In
    these the name is outlined from Geist SemiBold in the Logo's proportions:
    the name at 3/4 of the mark's height, 1/3 of it apart.
  - `favicon.svg`, a bolder cut (4-unit stroke) that keeps the three stems
    apart at 16px. It switches its square to the dark theme's colour through
    `prefers-color-scheme`.
  - `apple-touch-icon.png` (180px) and `icon-512.png`, full-bleed on the
    square's colour.
- **Contrast.** The accent mark is 3.5:1 on `--bg` in the light theme and 5.0:1
  in the dark theme, above the 3:1 that graphics need. `scripts/contrast.test.ts`
  checks this against `bg`, `sidebar-bg` and `surface-sunken`.
- **Licence.** `brand/NOTICE.md` records that the logo is original and that the
  lockups' outlines come from Geist under SIL OFL 1.1.

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

The `nu-design-system` rules form a small oxlint JS plugin
(`lint/plugin/`, TypeScript loaded by oxlint's `jsPlugins`), each with a test
file of rejected and accepted cases run through oxlint's own `RuleTester`.
oxlint 1.94's JS plugins proved usable, so **no ESLint fallback** is needed:
`pnpm lint` is `oxlint --type-aware && node scripts/check-brand.ts`.
`no-unknown-classes` loads Tailwind's design system once per lint run
(`__unstable__loadDesignSystem` from `@tailwindcss/node`, with our `theme.css`)
and asks it whether each class, variants included, produces CSS, so it never
drifts from the theme; `group` and `peer` markers are allowed.
`lint/fixtures/bad-screen.tsx` trips every row of the table, and a test proves
each fires.

Details of the scoping:

- The root `.oxlintrc.json` `extends` the adherence config; its `overrides`
  scope the rules to `apps/web/src/**` and the package's `components/`,
  `layouts/` and `brand/`. Both overrides repeat the root's "modules only
  through `index.ts`" import pattern, because an override's
  `no-restricted-imports` replaces the root's.
- Arbitrary variants (`data-[state=open]:`) and custom-property shorthands
  (`left-(--nu-menu-x)`) are allowed; arbitrary values are not.
- Test files are exempt from `no-raw-style-values` only (a test may assert a
  measured `"240px"`); every other rule applies to them.
- A `no-restricted-globals` rule in the same scope covers the "CDN globals"
  part of the other-kits row (`lucide`, `feather`, `FontAwesome`, `bootstrap`,
  `tailwind`).

From notnullsoft-admin's `_adherence.oxlintrc.json`: its hex, `px` and font
checks are folded into `no-raw-style-values` (the only font names allowed are
Geist and Geist Mono), and its deep-import restriction is the "internals" row,
all at error. Its per-component prop selectors are not carried over (strict
TypeScript over the ported props does that job), nor is its
`react/forbid-elements`, whose list was empty. Its token list became the
generator test's cross-check list. It had no other rule this table lacks.

**Icons** come from `lucide-react` through the ported `Icon` component (stroke
1.75, sizes 14 / 16 / 20, `currentColor`), never from a CDN.

**A missing component** is added to `packages/design-system` and never styled
ad hoc in a screen. A lint rule can't catch "should have been a component", so
review checks it.

## Components and layouts per screen

**Ported from the source** (the first Task that needs each one ports it; the
design-system package Task ports the shell and the forms):
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
`datetime-local` Input), `Disclosure` (a native `<details>` with a titled
summary, for help a form doesn't always need).

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
| Second factor | both | AuthLayout | CodeInput, Button, link "Use a recovery code"; when the admin has no factor yet (enrol): QrCodePanel with the setup key in CopyField, CodeInput, the 10 recovery codes in `type-mono` with Copy and "Download codes", Checkbox "I saved them" | Login |
| First-run setup, invitation, re-link | both | AuthLayout | Field, Input, PasswordInput with hint, QrCodePanel, recovery codes in `type-mono` with CopyField and "Download codes" (setup); invitation: Field and Input for username and display name, Button `secondary` "Continue with <provider>" per SSO provider; re-link: the same provider Buttons, no fields | Login |
| Files | both | AppShell | PageHeader with actions (Upload files, New folder), Breadcrumbs for the path, DataTable (name with file-type Icon, size `num` right-aligned, modified relative time, row Menu: Download, Share link (admin), Delete), EmptyState, DropZone, Dialog to confirm delete ("Delete 3 files?") | Users |
| Upload queue | both | AppShell | UploadQueue docked bottom-right, Toast "Upload complete" | – |
| Create / edit share link | admin | Dialog | Switch "Require a password", PasswordInput, ExpiryPicker, Alert `warning` for "No expiry", CopyField | UserDetail (suspend Dialog) |
| Share links | admin | AppShell | DataTable (item, Badge expiry, Badge password, Badge `danger` "Locked" while locked after wrong passwords, downloads `num`, created), Tag filters (Active / Expired / Revoked), row Menu (Copy link, Edit, Revoke) | Users |
| Users | admin | AppShell | Tabs (Users / Invitations), DataTable with Avatar, Badge status, linked providers, quota text, row Menu (Disable / Enable, Set quota, Unlink sign-in, Send re-link link → CopyField, Remove: Radio "Keep files" / "Delete files", type the username), Dialog confirms | Users |
| User detail | admin | AppShell, 2:1 | PageHeader with status + actions, DescriptionList, QuotaMeter, Timeline of the user's audit events | UserDetail |
| Invitations | admin | AppShell (tab of Users) | DataTable, Badge (Pending / Accepted / Expired / Revoked), Badge (Sent by email, Verified email required), Dialog "Invite user" with optional email, Checkboxes "Send the invitation to this email" and "Require a verified matching email", and expiry → CopyField, row Menu (Copy link, Resend for invitations sent by email, Revoke) | Users |
| Resources | admin | AppShell | DataTable or Card list with Badge (Available / Unavailable + reason) and Badge `warning` "Not encrypted" for an SMB share without encryption, Drawer form for local folder / SMB share, Button "Test connection" → Alert result, RadioGroup "Home root" | Settings |
| Admin settings | admin | AppShell | Tabs (General / Security / Email / Sign-in providers), label-left/controls-right rows, Switch, Input with unit `suffix`, Select, sticky "unsaved changes" bar | Settings |
| Account settings | both | AppShell | Tabs (Profile / Password / Two-step sign-in / Linked sign-ins / Sessions), label-left rows, DataTable of sessions, Dialog confirms; Two-step sign-in (admin): list of authenticator apps with Remove, "Add another app" (QrCodePanel, CodeInput), "Regenerate recovery codes" with how many are left; the recent sign-in Dialog takes the password or an authenticator code | Settings |
| Audit log | admin | AppShell | Filters (date range, actor, action, outcome Tag), day-grouped Timeline, "Details" opens a Drawer with the event as DescriptionList, Pagination, Button "Export CSV"; the timezone is stated | AuditLog |
| Public share page | public | PublicLayout | Card with name, size and expiry, PasswordInput + Button when protected, Button "Download", DataTable for a folder link, Alert "This link is not valid" | Login |

**Wording** follows the source README's content rules unchanged: sentence
case; buttons are verb + object ("Create share link", "Revoke link"); a confirm
title is a question naming the object, and its body says the consequence; toasts
are past tense ("Link revoked"); empty states say why and what to do; times are
relative in lists and absolute in details and the audit log; no emoji, no
exclamation marks.

## Owners

- **Skeleton** (Task 94776ed7-0244-4ba0-bd52-a6cfbac33271): the monorepo,
  `apps/web` and the root lint config the package builds on.
- **Design-system package** (Task 2684133c-9b0b-4556-b7de-d9d09c005273, split
  off the skeleton): the package, the token generator and both CSS files,
  fonts, the brand placeholders, the three layouts, the core, shell and form
  components (Icon, Button, IconButton, Badge, Avatar, Card, Tooltip, Menu,
  Sidebar, Topbar, PageHeader, Breadcrumbs, Field, Input, PasswordInput,
  Textarea, Select, Checkbox, Radio + RadioGroup, Switch, SegmentedControl),
  the lint config and plugin, the brand check, and the web app's wiring.
- **Logo** (Task e36ce243-e93e-4a5b-9246-4a35c704f7d3): replaces the
  placeholders in `brand/`.
- Each feature Task: its screens above, and the components it is the first to
  need, ported or built into the package.
