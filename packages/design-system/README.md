# NotUnreachable Design System

The design system of **NotUnreachable**'s web app: tokens, components, layouts and writing rules for a
dense, data-heavy interface used all day, where legibility beats expression. Screens style only
through these components and the semantic classes of `theme.css`; the lint rules in
`lint/adherence.oxlintrc.json` enforce it (see `docs/design/design-system.md` in the repo).

## Using it

```css
/* apps/web/src/main.css, the web app's only CSS file */
@import "@not-unreachable/design-system/theme.css";
@source "../../../packages/design-system/src";
```

```tsx
import { AppShell, Button, Field, Input } from "@not-unreachable/design-system";
```

Nothing else can be imported from outside the package, apart from the brand's static files
(`@not-unreachable/design-system/brand/favicon.svg`). Tokens live in `tokens/tokens.json`; after editing it,
run `pnpm tokens` here to regenerate `src/tokens.css`, `src/theme.css` and the token reference below.

| Base           |                                                                  |
| -------------- | ---------------------------------------------------------------- |
| Neutrals       | near-neutral Gray, `--gray-50` page, white cards                 |
| Primary button | **Ink** fill (`--primary`); Ember reserved                       |
| Base type      | **14px body, 13px dense UI**, 24px page titles, no display sizes |
| Controls       | **32px** (28 sm / 40 lg); table rows 44px                        |
| Radii          | 4 / 6 / **8** / **12**                                           |
| Links          | ink + underline, ember on hover                                  |

---

## CONTENT FUNDAMENTALS

Voice is **a senior engineer talking to a peer**, but in an app most copy is labels, so it is terse.

- **Person:** the UI addresses the user as "you" only when necessary ("You have unsaved changes"). Never "I", never "we" inside the product. System actions are attributed to **System** in logs.
- **Casing:** Sentence case everywhere: page titles, buttons, table headers, menu items. IDs and codes stay as they are, in mono (`usr_8f2k1`, `shr_10482`). Write the product as **NotUnreachable**.
- **Buttons:** verb + object, 1–3 words. _Invite user, Export CSV, Create share link, Reset password, Save changes._ Destructive confirms repeat the verb ("Revoke link", never "OK" / "Yes").
- **Confirmations:** title as a question naming the object ("Delete 3 files?"), body says the consequence and the way back ("They are removed for everyone. This can't be undone.").
- **Toasts:** past tense, object first: "Link revoked", "Reset link sent", "Settings saved". Add Undo for reversible actions.
- **Empty states:** say why it's empty + what to do. "No files match these filters. Try removing a filter or searching by name."
- **Numbers:** always real units and comparisons: "4.2 / 10 GB", "184 ms", "41 / 50 seats". Thousands separators, tabular figures, right-aligned in tables. Missing value = em dash "—".
- **Time:** relative for recency in lists ("5m ago", "2 days ago"), absolute in details and logs ("20 Oct, 14:02", "14:02 UTC"). State the timezone on audit screens.
- **Banned:** emoji, exclamation marks, "Oops", "Whoops", jokes in errors, "solutions", "seamless".

## VISUAL FOUNDATIONS

- **Colour vibe:** neutral, quiet, high-contrast. ~90% gray/white surfaces, ink text, colour only where it carries meaning (status, data, focus). **Ember `#F23D0F`** is the accent: focus ring, active nav icon, active tab underline, checked controls, selected-row tint, the notification dot. Never for large fills or body text. The one ember-filled moment, the sign-in button, uses `--accent-fill` (ember-600), so its white label reads at 5.3:1. Flare orange is a chart colour only.
- **Status colours:** green success, amber warning, crimson danger, blue info, gray neutral, each with `-subtle` (fill), `-border`, solid, and `-fg` (text, ≥4.5:1 on subtle). Crimson (`#C8102E`) is deliberately cooler and darker than Ember so errors never read as the accent.
- **Type:** Geist for everything, Geist Mono for IDs, codes, timestamps, keyboard hints and 11px uppercase overlines (sidebar section labels). Page title 24/600, section 16/600, card title 14/600, body 14/400, dense UI 13. Tight tracking (−1.5%) only on titles, metrics and the wordmark. **Tabular numerals** on every number that aligns.
- **Spacing:** 4px base. Inside controls 6–12px, between controls 8px, between cards 16px, page padding 24px, card padding 20px. Comfortable density: 32px controls, 44px rows (36 compact / 52 relaxed).
- **Backgrounds:** flat. Page `--bg` (gray-50), cards white. No gradients, textures, illustrations or imagery in product chrome. The only gradient is the skeleton shimmer.
- **Borders:** 1px hairlines do the structural work: cards, table rows (`--border-subtle`), header dividers. Inputs use `--border-control` (3:1 against the surface) + shadow-1; secondary buttons use `--border-strong`.
- **Cards:** white, 1px border, 8px radius, **no shadow**. Title row inside; `padding="none"` for tables puts a divider under the header. No coloured left borders, no tinted card backgrounds.
- **Shadows:** cool-black, low. shadow-1 on inputs and secondary buttons, shadow-2 raised panels (sign-in card), shadow-3 for anything floating: menus, tooltips, dialogs, drawers, toasts. In dark mode shadows add a white 1px ring.
- **Radii:** 4 badges and tooltips, 6 controls, 8 cards and menus, 12 dialogs and the sign-in card, pills only for filter Tags and Switches, circles for avatars and status dots.
- **Hover:** background tint, never opacity. Ghost/secondary → `--control-hover`; primary ink → gray-700; table rows → `--surface-hover`; danger-ghost → danger-subtle.
- **Press:** one step darker + 1px translateY on buttons. No scale, no bounce.
- **Focus:** ember border + 3px 30% ember ring (`--focus-ring`) on every focusable control.
- **Selection:** selected rows get `--surface-selected` (ember-50). Checked checkbox/radio/switch = ember.
- **Motion:** fast and functional: 80ms press, 120ms hover/colour, 200ms menus and switches, 280ms drawers. `--ease-out`. Drawer slides 24px + fade; dialogs simply appear over the overlay. No decorative animation, and none at all with `prefers-reduced-motion`.
- **Transparency & blur:** sticky topbar (surface @88% + blur) and dialog/drawer overlay (gray-950 @45%). Nowhere else.
- **Layout:** fixed 240px sidebar (56px collapsed) + 56px sticky topbar; content max 1440px. Page = PageHeader (title, description, actions, tabs) → filters/toolbar → content cards. Detail pages: 2:1 with a details column on the right. Settings: label-left/controls-right rows.
- **Dark mode:** `data-theme="dark"` on `<html>` remaps every alias. Primary button inverts to light; Ember stays the same hue.
- **Imagery:** none in chrome. Avatars fall back to tinted initials.

## ICONOGRAPHY

- **Set:** [Lucide](https://lucide.dev) through `lucide-react`, bundled with the app and never loaded from a CDN. The `Icon` component renders the curated set in `src/components/Icon/icons.ts` (add an icon there when a screen needs it) at **stroke 1.75**, round caps and joins.
- **Sizes:** 14 in sm buttons and menus, 16 default (nav, buttons), 20 in empty states.
- **Colour:** `currentColor`. Nav icons are fg-2, the active one Ember. Status colour only inside status contexts (alerts, toasts, timeline nodes).
- **Usage:** icons support labels; icon-only buttons always have a `label` (their accessible name and tooltip). One icon per button at most.
- **No emoji, no icon fonts, no filled/duotone icons.** Unicode only for `×` (tag remove), `…` (truncation), `—` (empty value), `⌘K` hints.

## LOGO

`src/brand/` holds the brand: `<Logo />` (mark + wordmark) in the sidebar header and on the sign-in screen,
`<Logo variant="mark" />` when the sidebar is collapsed, `<Wordmark />` for the name alone. Screens show the
brand only through these, so a new logo changes `src/brand/` and nothing else. The current mark is a
**placeholder** (see `src/brand/NOTICE.md`).

---

## Index

- `tokens/tokens.json`: every colour (light + dark), type family and style, spacing, radius, shadow, font size, weight, line height, tracking, border width, duration, easing and z-index token.
- `src/tokens.css`: the tokens as CSS custom properties, plus the radius roles (`--radius-control`, `--radius-card`, `--radius-dialog`, `--radius-badge`) and the `--type-*` font shorthands. Generated.
- `src/theme.css`: the Tailwind 4 theme over the tokens, the `type-*` utilities, the fonts and the base element rules. Generated.
- `src/fonts/`: Geist and Geist Mono (variable woff2), SIL OFL (`OFL.txt`).
- `src/components/`: one folder per component, `<Name>.tsx` with its props and usage as TSDoc, `<Name>.test.tsx`, `index.ts`.
- `src/layouts/`: AuthLayout, AppShell, PublicLayout.
- `src/brand/`: Logo, Wordmark, the mark and the favicons.
- `lint/`: the adherence rules and the `nu-design-system` lint plugin.
- `scripts/`: the token generator and the brand icon renderer.

## Components

- **core:** Button (+ ButtonLink, a link that looks like one), IconButton (+ IconButtonLink), Badge, Tag, Avatar, Card, Icon, Tooltip, Menu
- **forms:** Field, Input, Combobox (an Input with suggestions under it), PasswordInput, CodeInput (a one-time code, one box per digit), Textarea, Select, SelectMenu (a dropdown whose options can have a second line), Checkbox, Radio (+ RadioGroup), Switch, SegmentedControl, ExpiryPicker (presets and a custom time, or no expiry)
- **navigation:** Sidebar, Topbar, PageHeader, Breadcrumbs, Tabs (+ TabPanel; link tabs for routes), Pagination (cursor-based)
- **data:** DataTable, DescriptionList, CopyField (a value with a copy button), QrCodePanel (a QR code with its setup key), Timeline (flat or grouped by day)
- **overlays:** Dialog, Drawer (native `<dialog>` + `showModal()`)
- **feedback:** Alert, Toast (+ ToastProvider, `useToast()`), EmptyState, Disclosure (a titled block that folds away, for help a form doesn't always need)
- **layouts:** AuthLayout, AppShell, PublicLayout

Still to port, by the first screen that needs each: ProgressBar, Skeleton. A missing component is added here,
never styled ad hoc in a screen.

## Token reference

<!-- token-reference:start (generated by scripts/build-tokens.ts) -->

### Colours

| Token                 | Value (light / dark)                       | Usage                                                                                                                                                                      | In Tailwind                                                 |
| --------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `--ember-50`          | `#FFF2ED`                                  | Ember accent ramp. Use through the semantic aliases (accent, focus, selection), never as a large fill or body text.                                                        | – A ramp: use it through the semantic aliases.              |
| `--ember-100`         | `#FFE0D4`                                  | Ember accent ramp. Use through the semantic aliases (accent, focus, selection), never as a large fill or body text.                                                        | – A ramp: use it through the semantic aliases.              |
| `--ember-200`         | `#FFBDA6`                                  | Ember accent ramp. Use through the semantic aliases (accent, focus, selection), never as a large fill or body text.                                                        | – A ramp: use it through the semantic aliases.              |
| `--ember-300`         | `#FF9370`                                  | Ember accent ramp. Use through the semantic aliases (accent, focus, selection), never as a large fill or body text.                                                        | – A ramp: use it through the semantic aliases.              |
| `--ember-400`         | `#FF6638`                                  | Ember accent ramp. Use through the semantic aliases (accent, focus, selection), never as a large fill or body text.                                                        | – A ramp: use it through the semantic aliases.              |
| `--ember-500`         | `#F23D0F`                                  | Ember accent ramp. Use through the semantic aliases (accent, focus, selection), never as a large fill or body text.                                                        | – A ramp: use it through the semantic aliases.              |
| `--ember-600`         | `#CC2F07`                                  | Ember accent ramp. Use through the semantic aliases (accent, focus, selection), never as a large fill or body text.                                                        | – A ramp: use it through the semantic aliases.              |
| `--ember-700`         | `#9E2406`                                  | Ember accent ramp. Use through the semantic aliases (accent, focus, selection), never as a large fill or body text.                                                        | – A ramp: use it through the semantic aliases.              |
| `--ember-800`         | `#6E1906`                                  | Ember accent ramp. Use through the semantic aliases (accent, focus, selection), never as a large fill or body text.                                                        | – A ramp: use it through the semantic aliases.              |
| `--ember-900`         | `#3D0E04`                                  | Ember accent ramp. Use through the semantic aliases (accent, focus, selection), never as a large fill or body text.                                                        | – A ramp: use it through the semantic aliases.              |
| `--flare-100`         | `#FFE9C7`                                  | Flare orange ramp. A chart colour only (chart-4); flare-300 is the dark-theme warning text.                                                                                | – A ramp: use it through the semantic aliases.              |
| `--flare-300`         | `#FFC266`                                  | Flare orange ramp. A chart colour only (chart-4); flare-300 is the dark-theme warning text.                                                                                | – A ramp: use it through the semantic aliases.              |
| `--flare-500`         | `#FF9A1F`                                  | Flare orange ramp. A chart colour only (chart-4); flare-300 is the dark-theme warning text.                                                                                | – A ramp: use it through the semantic aliases.              |
| `--flare-700`         | `#B86505`                                  | Flare orange ramp. A chart colour only (chart-4); flare-300 is the dark-theme warning text.                                                                                | – A ramp: use it through the semantic aliases.              |
| `--white`             | `#FFFFFF`                                  | Pure white: light-theme cards, sidebar and text on ink or ember fills.                                                                                                     | – A ramp: use it through the semantic aliases.              |
| `--gray-25`           | `#FAFAF9`                                  | Near-neutral gray ramp, a whisper warm, tuned for legibility. Use through the semantic aliases.                                                                            | – A ramp: use it through the semantic aliases.              |
| `--gray-50`           | `#F4F4F2`                                  | Near-neutral gray ramp, a whisper warm, tuned for legibility. Use through the semantic aliases.                                                                            | – A ramp: use it through the semantic aliases.              |
| `--gray-100`          | `#E9E9E6`                                  | Near-neutral gray ramp, a whisper warm, tuned for legibility. Use through the semantic aliases.                                                                            | – A ramp: use it through the semantic aliases.              |
| `--gray-150`          | `#DEDEDA`                                  | Near-neutral gray ramp, a whisper warm, tuned for legibility. Use through the semantic aliases.                                                                            | – A ramp: use it through the semantic aliases.              |
| `--gray-200`          | `#D1D1CC`                                  | Near-neutral gray ramp, a whisper warm, tuned for legibility. Use through the semantic aliases.                                                                            | – A ramp: use it through the semantic aliases.              |
| `--gray-300`          | `#B1B1AB`                                  | Near-neutral gray ramp, a whisper warm, tuned for legibility. Use through the semantic aliases.                                                                            | – A ramp: use it through the semantic aliases.              |
| `--gray-400`          | `#8A8A84`                                  | Near-neutral gray ramp, a whisper warm, tuned for legibility. Use through the semantic aliases.                                                                            | – A ramp: use it through the semantic aliases.              |
| `--gray-500`          | `#6B6B66`                                  | Near-neutral gray ramp, a whisper warm, tuned for legibility. Use through the semantic aliases.                                                                            | – A ramp: use it through the semantic aliases.              |
| `--gray-600`          | `#50504C`                                  | Near-neutral gray ramp, a whisper warm, tuned for legibility. Use through the semantic aliases.                                                                            | – A ramp: use it through the semantic aliases.              |
| `--gray-700`          | `#3A3A37`                                  | Near-neutral gray ramp, a whisper warm, tuned for legibility. Use through the semantic aliases.                                                                            | – A ramp: use it through the semantic aliases.              |
| `--gray-800`          | `#262624`                                  | Near-neutral gray ramp, a whisper warm, tuned for legibility. Use through the semantic aliases.                                                                            | – A ramp: use it through the semantic aliases.              |
| `--gray-900`          | `#181817`                                  | Near-neutral gray ramp, a whisper warm, tuned for legibility. Use through the semantic aliases.                                                                            | – A ramp: use it through the semantic aliases.              |
| `--gray-950`          | `#0F0F0E`                                  | Near-neutral gray ramp, a whisper warm, tuned for legibility. Use through the semantic aliases.                                                                            | – A ramp: use it through the semantic aliases.              |
| `--green-50`          | `#EDF8F1`                                  | Green status ramp, behind success and positive.                                                                                                                            | – A ramp: use it through the semantic aliases.              |
| `--green-100`         | `#D5F0DF`                                  | Green status ramp, behind success and positive.                                                                                                                            | – A ramp: use it through the semantic aliases.              |
| `--green-500`         | `#1E9E57`                                  | Green status ramp, behind success and positive.                                                                                                                            | – A ramp: use it through the semantic aliases.              |
| `--green-600`         | `#17834A`                                  | Green status ramp, behind success and positive.                                                                                                                            | – A ramp: use it through the semantic aliases.              |
| `--green-700`         | `#106A3B`                                  | Green status ramp, behind success and positive.                                                                                                                            | – A ramp: use it through the semantic aliases.              |
| `--amber-50`          | `#FFF8E6`                                  | Amber status ramp, behind warning.                                                                                                                                         | – A ramp: use it through the semantic aliases.              |
| `--amber-100`         | `#FFEDC2`                                  | Amber status ramp, behind warning.                                                                                                                                         | – A ramp: use it through the semantic aliases.              |
| `--amber-500`         | `#E5A00D`                                  | Amber status ramp, behind warning.                                                                                                                                         | – A ramp: use it through the semantic aliases.              |
| `--amber-600`         | `#B57C06`                                  | Amber status ramp, behind warning.                                                                                                                                         | – A ramp: use it through the semantic aliases.              |
| `--amber-700`         | `#865B05`                                  | Amber status ramp, behind warning.                                                                                                                                         | – A ramp: use it through the semantic aliases.              |
| `--red-50`            | `#FDEEF0`                                  | Crimson status ramp, behind danger and negative; deliberately cooler and darker than Ember so errors never read as the accent.                                             | – A ramp: use it through the semantic aliases.              |
| `--red-100`           | `#FAD9DD`                                  | Crimson status ramp, behind danger and negative; deliberately cooler and darker than Ember so errors never read as the accent.                                             | – A ramp: use it through the semantic aliases.              |
| `--red-500`           | `#C8102E`                                  | Crimson status ramp, behind danger and negative; deliberately cooler and darker than Ember so errors never read as the accent.                                             | – A ramp: use it through the semantic aliases.              |
| `--red-600`           | `#AA0D27`                                  | Crimson status ramp, behind danger and negative; deliberately cooler and darker than Ember so errors never read as the accent.                                             | – A ramp: use it through the semantic aliases.              |
| `--red-700`           | `#8E0B20`                                  | Crimson status ramp, behind danger and negative; deliberately cooler and darker than Ember so errors never read as the accent.                                             | – A ramp: use it through the semantic aliases.              |
| `--blue-50`           | `#EEF3FD`                                  | Blue status ramp, behind info and chart-2.                                                                                                                                 | – A ramp: use it through the semantic aliases.              |
| `--blue-100`          | `#DAE5FA`                                  | Blue status ramp, behind info and chart-2.                                                                                                                                 | – A ramp: use it through the semantic aliases.              |
| `--blue-500`          | `#2F6BDB`                                  | Blue status ramp, behind info and chart-2.                                                                                                                                 | – A ramp: use it through the semantic aliases.              |
| `--blue-600`          | `#2358BD`                                  | Blue status ramp, behind info and chart-2.                                                                                                                                 | – A ramp: use it through the semantic aliases.              |
| `--blue-700`          | `#1D4699`                                  | Blue status ramp, behind info and chart-2.                                                                                                                                 | – A ramp: use it through the semantic aliases.              |
| `--teal-500`          | `#14A38B`                                  | Chart series 3 only.                                                                                                                                                       | – A ramp: use it through the semantic aliases.              |
| `--violet-500`        | `#7C5CD6`                                  | Chart series 5 only.                                                                                                                                                       | – A ramp: use it through the semantic aliases.              |
| `--bg`                | `{gray-50}` / `{gray-950}`                 | Page background (gray-50 light, gray-950 dark). Behind cards; never inside them.                                                                                           | `--color-bg`                                                |
| `--surface`           | `{white}` / `{gray-900}`                   | Cards, tables, inputs, dialogs and drawers.                                                                                                                                | `--color-surface`                                           |
| `--surface-raised`    | `{white}` / `{gray-800}`                   | Raised panels and floating surfaces (menus, popovers); lighter than surface in dark.                                                                                       | `--color-surface-raised`                                    |
| `--surface-sunken`    | `{gray-50}` / `#0A0A09`                    | Sunken insets and table headers.                                                                                                                                           | `--color-surface-sunken`                                    |
| `--surface-hover`     | `{gray-25}` / `#1E1E1C`                    | Table row hover.                                                                                                                                                           | `--color-surface-hover`                                     |
| `--surface-selected`  | `{ember-50}` / `#301F1A`                   | Selected table rows (ember-50 tint). Dark value is ember-500 mixed 12% into gray-900 in oklab.                                                                             | `--color-surface-selected`                                  |
| `--surface-inverse`   | `{gray-900}` / `{gray-50}`                 | Inverted surfaces such as tooltips; text on it is fg-inverse.                                                                                                              | `--color-surface-inverse`                                   |
| `--sidebar-bg`        | `{white}` / `{gray-950}`                   | Sidebar background.                                                                                                                                                        | `--color-sidebar`                                           |
| `--sidebar-fg`        | `{gray-600}` / `{gray-300}`                | Sidebar item text and icons on sidebar-bg (8.1:1 light, 8.9:1 dark).                                                                                                       | `--color-sidebar-fg`                                        |
| `--sidebar-active-bg` | `{gray-50}` / `{gray-800}`                 | Active sidebar item fill.                                                                                                                                                  | `--color-sidebar-active`                                    |
| `--sidebar-active-fg` | `{gray-950}` / `{white}`                   | Active sidebar item text on sidebar-active-bg (17.4:1 light, 15.2:1 dark); its icon is ember.                                                                              | `--color-sidebar-active-fg`                                 |
| `--fg-1`              | `{gray-950}` / `#F4F4F2`                   | Primary text, titles and values on bg, surface, surface-raised and surface-selected (14.3:1 or more in both themes).                                                       | `--color-fg-1`                                              |
| `--fg-2`              | `{gray-600}` / `{gray-300}`                | Secondary text, descriptions and nav icons on bg, surface and surface-raised (7.0:1 or more).                                                                              | `--color-fg-2`                                              |
| `--fg-3`              | `{gray-500}` / `{gray-400}`                | Tertiary text: captions, axis labels, placeholders, timestamps on surface and bg (4.9:1 light on bg, 5.1:1 or more elsewhere).                                             | `--color-fg-3`                                              |
| `--fg-disabled`       | `{gray-400}` / `{gray-600}`                | Disabled labels only (3.5:1 light, 2.2:1 dark on surface: below 4.5:1, which WCAG exempts for disabled controls).                                                          | `--color-fg-disabled`                                       |
| `--fg-inverse`        | `{white}` / `{gray-950}`                   | Text on surface-inverse.                                                                                                                                                   | `--color-fg-inverse`                                        |
| `--fg-on-accent`      | `{white}`                                  | Text and icons on accent-fill and danger fills (5.3:1 or more). Never on accent itself: white on ember-500 is 3.85:1.                                                      | `--color-fg-on-accent`                                      |
| `--border`            | `{gray-150}` / `{gray-800}`                | Default 1px hairline: cards, header dividers.                                                                                                                              | `--color-border`                                            |
| `--border-subtle`     | `{gray-100}` / `#1E1E1C`                   | Table row dividers and the lightest separators.                                                                                                                            | `--color-border-subtle`                                     |
| `--border-strong`     | `{gray-200}` / `{gray-700}`                | Secondary-button borders (with shadow-1) and link underlines. 1.5:1 on surface, so never the only boundary of an input: use border-control there.                          | `--color-border-strong`                                     |
| `--border-control`    | `{gray-400}` / `{gray-500}`                | Borders of inputs, selects, textareas, checkboxes, radios and switches (3:1 or more on surface, WCAG 1.4.11).                                                              | `--color-border-control`                                    |
| `--border-focus`      | `{ember-500}`                              | Focused control border, with the focus-ring shadow (3.9:1 light, 4.6:1 dark on surface).                                                                                   | `--color-border-focus`                                      |
| `--accent`            | `{ember-500}`                              | Ember accent: focus, active nav icon, active tab underline, checked controls, notification dot. Never large fills, body text or a fill behind text: use accent-fill there. | `--color-accent`                                            |
| `--accent-hover`      | `{ember-600}` / `{ember-400}`              | Hover state of accent marks; also link hover (text-link-hover).                                                                                                            | `--color-accent-hover`                                      |
| `--accent-press`      | `{ember-700}` / `{ember-600}`              | Pressed state of accent marks.                                                                                                                                             | `--color-accent-press`                                      |
| `--accent-fill`       | `{ember-600}`                              | Fill of the accent button behind fg-on-accent (5.3:1), the sign-in button.                                                                                                 | `--color-accent-fill`                                       |
| `--accent-fill-hover` | `{ember-700}`                              | Accent button hover.                                                                                                                                                       | `--color-accent-fill-hover`                                 |
| `--accent-fill-press` | `{ember-800}`                              | Accent button pressed.                                                                                                                                                     | `--color-accent-fill-press`                                 |
| `--accent-subtle`     | `{ember-50}` / `rgba(242,61,15,0.16)`      | Tinted ember fill behind accent-subtle-fg (accent Badge).                                                                                                                  | `--color-accent-subtle`                                     |
| `--accent-subtle-fg`  | `{ember-700}` / `{ember-300}`              | Text on accent-subtle (7.1:1 light, 7.0:1 dark).                                                                                                                           | `--color-accent-subtle-fg`                                  |
| `--primary`           | `{gray-900}` / `{gray-50}`                 | Ink fill of the primary button: one per view. Inverts to light in dark.                                                                                                    | `--color-primary`                                           |
| `--primary-hover`     | `{gray-700}` / `{gray-150}`                | Primary button hover (gray-700 light).                                                                                                                                     | `--color-primary-hover`                                     |
| `--primary-press`     | `{gray-600}` / `{gray-200}`                | Primary button pressed.                                                                                                                                                    | `--color-primary-press`                                     |
| `--primary-fg`        | `{white}` / `{gray-950}`                   | Text on primary (17.8:1 light, 17.4:1 dark).                                                                                                                               | `--color-primary-fg`                                        |
| `--control-hover`     | `{gray-50}` / `{gray-800}`                 | Hover fill for ghost and secondary controls.                                                                                                                               | `--color-control-hover`                                     |
| `--control-press`     | `{gray-100}` / `{gray-700}`                | Pressed fill for ghost and secondary controls.                                                                                                                             | `--color-control-press`                                     |
| `--success`           | `{green-500}`                              | Solid success colour: status dots, icons, progress fills.                                                                                                                  | `--color-success`                                           |
| `--success-subtle`    | `{green-50}` / `rgba(30,158,87,0.16)`      | Success fill behind success-fg (Badge, Alert, Toast).                                                                                                                      | `--color-success-subtle`                                    |
| `--success-fg`        | `{green-700}` / `#6FD69B`                  | Success text on success-subtle (6.1:1 light, 8.1:1 dark).                                                                                                                  | `--color-success-fg`                                        |
| `--success-border`    | `{green-100}` / `rgba(30,158,87,0.3)`      | Border of success Alerts and Badges.                                                                                                                                       | `--color-success-border`                                    |
| `--warning`           | `{amber-500}`                              | Solid warning colour: status dots, icons, progress fills.                                                                                                                  | `--color-warning`                                           |
| `--warning-subtle`    | `{amber-50}` / `rgba(229,160,13,0.16)`     | Warning fill behind warning-fg.                                                                                                                                            | `--color-warning-subtle`                                    |
| `--warning-fg`        | `{amber-700}` / `{flare-300}`              | Warning text on warning-subtle (5.6:1 light, 8.4:1 dark).                                                                                                                  | `--color-warning-fg`                                        |
| `--warning-border`    | `{amber-100}` / `rgba(229,160,13,0.3)`     | Border of warning Alerts and Badges.                                                                                                                                       | `--color-warning-border`                                    |
| `--danger`            | `{red-500}`                                | Solid danger colour: destructive button fill, error dots and icons (3.0:1 on surface in dark: use danger-fg for text there).                                               | `--color-danger`                                            |
| `--danger-hover`      | `{red-600}`                                | Danger button hover.                                                                                                                                                       | `--color-danger-hover`                                      |
| `--danger-press`      | `{red-700}`                                | Danger button pressed.                                                                                                                                                     | `--color-danger-press`                                      |
| `--danger-subtle`     | `{red-50}` / `rgba(200,16,46,0.2)`         | Danger fill behind danger-fg; danger-ghost hover.                                                                                                                          | `--color-danger-subtle`                                     |
| `--danger-fg`         | `{red-700}` / `#FF8A97`                    | Danger text and input error messages on danger-subtle and surface (7.1:1 or more).                                                                                         | `--color-danger-fg`                                         |
| `--danger-border`     | `{red-100}` / `rgba(200,16,46,0.36)`       | Border of danger Alerts and Badges; input error border tint.                                                                                                               | `--color-danger-border`                                     |
| `--info`              | `{blue-500}`                               | Solid info colour: status dots, icons.                                                                                                                                     | `--color-info`                                              |
| `--info-subtle`       | `{blue-50}` / `rgba(47,107,219,0.18)`      | Info fill behind info-fg.                                                                                                                                                  | `--color-info-subtle`                                       |
| `--info-fg`           | `{blue-700}` / `#93B5F5`                   | Info text on info-subtle (7.9:1 light, 7.3:1 dark).                                                                                                                        | `--color-info-fg`                                           |
| `--info-border`       | `{blue-100}` / `rgba(47,107,219,0.34)`     | Border of info Alerts and Badges.                                                                                                                                          | `--color-info-border`                                       |
| `--neutral-subtle`    | `{gray-50}` / `{gray-800}`                 | Neutral Badge fill.                                                                                                                                                        | `--color-neutral-subtle`                                    |
| `--neutral-fg`        | `{gray-600}` / `{gray-300}`                | Neutral Badge text on neutral-subtle (7.4:1 light, 7.0:1 dark).                                                                                                            | `--color-neutral-fg`                                        |
| `--neutral-border`    | `{gray-150}` / `{gray-700}`                | Neutral Badge border.                                                                                                                                                      | `--color-neutral-border`                                    |
| `--text-link`         | `{fg-1}`                                   | Link text: ink, underlined with border-strong.                                                                                                                             | `--color-link`                                              |
| `--text-link-hover`   | `{accent-hover}`                           | Link hover: ember, underline turns currentColor.                                                                                                                           | `--color-link-hover`                                        |
| `--overlay`           | `rgba(15,15,14,0.45)` / `rgba(0,0,0,0.65)` | Dialog and drawer backdrop (gray-950 at 45% light, black at 65% dark).                                                                                                     | `--color-overlay`                                           |
| `--positive`          | `{green-600}` / `#6FD69B`                  | Good deltas in StatCards and sparklines, on surface (4.8:1 light, 10.0:1 dark).                                                                                            | `--color-positive`                                          |
| `--negative`          | `{red-600}` / `#FF8A97`                    | Bad deltas in StatCards and sparklines, on surface (7.5:1 light, 7.9:1 dark).                                                                                              | `--color-negative`                                          |
| `--chart-1`           | `{ember-500}`                              | Chart series 1 (ember). Series keep this fixed order.                                                                                                                      | – Charts are not ported yet; the first chart exposes these. |
| `--chart-2`           | `{blue-500}`                               | Chart series 2 (blue).                                                                                                                                                     | – Charts are not ported yet; the first chart exposes these. |
| `--chart-3`           | `{teal-500}`                               | Chart series 3 (teal).                                                                                                                                                     | – Charts are not ported yet; the first chart exposes these. |
| `--chart-4`           | `{flare-500}`                              | Chart series 4 (flare).                                                                                                                                                    | – Charts are not ported yet; the first chart exposes these. |
| `--chart-5`           | `{violet-500}`                             | Chart series 5 (violet).                                                                                                                                                   | – Charts are not ported yet; the first chart exposes these. |
| `--chart-6`           | `{gray-400}` / `{gray-500}`                | Chart series 6 (gray) and comparison periods as a dashed line.                                                                                                             | – Charts are not ported yet; the first chart exposes these. |
| `--chart-grid`        | `{gray-100}` / `{gray-800}`                | Dashed chart gridlines.                                                                                                                                                    | – Charts are not ported yet; the first chart exposes these. |
| `--chart-axis`        | `{gray-500}` / `{gray-400}`                | Chart axis labels, 11px (5.4:1 light, 5.1:1 dark on surface).                                                                                                              | – Charts are not ported yet; the first chart exposes these. |
| `--chart-track`       | `{gray-100}` / `{gray-800}`                | Donut and progress tracks behind the value.                                                                                                                                | – Charts are not ported yet; the first chart exposes these. |

### Type roles

| Class                | Font                         | Usage                                                                            |
| -------------------- | ---------------------------- | -------------------------------------------------------------------------------- |
| `type-page-title`    | 600 24px/1.25 sans, -0.015em | Page titles in PageHeader (type-page-title); tight tracking.                     |
| `type-section-title` | 600 16px/1.4 sans            | Section titles (type-section-title).                                             |
| `type-card-title`    | 600 14px/1.4 sans            | Card titles (type-card-title).                                                   |
| `type-body`          | 400 14px/1.5 sans            | Body copy and table cells (type-body); the page default.                         |
| `type-body-sm`       | 400 13px/1.45 sans           | Dense UI text and descriptions (type-body-sm).                                   |
| `type-label`         | 500 13px/1.3 sans            | Form labels, buttons, nav items (type-label).                                    |
| `type-caption`       | 400 12px/1.4 sans            | Captions, hints and helper text (type-caption).                                  |
| `type-metric`        | 600 30px/1.1 sans, -0.015em  | Big KPI values, tabular figures (type-metric).                                   |
| `type-metric-sm`     | 600 24px/1.15 sans, -0.015em | Smaller KPI values (type-metric-sm).                                             |
| `type-overline`      | 500 11px/1.2 mono, 0.06em    | 11px uppercase overlines: sidebar section labels (type-overline), tracking-caps. |
| `type-mono`          | 400 13px/1.5 mono            | IDs, codes, timestamps, keyboard hints (type-mono).                              |

### Spacing and sizes

| Token                 | Value (light / dark) | Usage                                                 | In Tailwind                                            |
| --------------------- | -------------------- | ----------------------------------------------------- | ------------------------------------------------------ |
| `--space-0`           | `0`                  | No gap.                                               | – A multiple of --spacing (space-1): `p-5` is space-5. |
| `--space-px`          | `1px`                | 1px step.                                             | – A multiple of --spacing (space-1): `p-5` is space-5. |
| `--space-0-5`         | `2px`                | 2px step.                                             | – A multiple of --spacing (space-1): `p-5` is space-5. |
| `--space-1`           | `4px`                | The 4px base step every spacing value is built on.    | `--spacing`                                            |
| `--space-1-5`         | `6px`                | 6px: the low end of padding inside controls (6–12px). | – A multiple of --spacing (space-1): `p-5` is space-5. |
| `--space-2`           | `8px`                | 8px: the gap between controls.                        | – A multiple of --spacing (space-1): `p-5` is space-5. |
| `--space-3`           | `12px`               | 12px: the high end of padding inside controls.        | – A multiple of --spacing (space-1): `p-5` is space-5. |
| `--space-4`           | `16px`               | Between cards.                                        | – A multiple of --spacing (space-1): `p-5` is space-5. |
| `--space-5`           | `20px`               | Card padding (card-padding).                          | – A multiple of --spacing (space-1): `p-5` is space-5. |
| `--space-6`           | `24px`               | Page padding (page-padding).                          | – A multiple of --spacing (space-1): `p-5` is space-5. |
| `--space-8`           | `32px`               | 32px step.                                            | – A multiple of --spacing (space-1): `p-5` is space-5. |
| `--space-10`          | `40px`               | 40px step.                                            | – A multiple of --spacing (space-1): `p-5` is space-5. |
| `--space-12`          | `48px`               | 48px step.                                            | – A multiple of --spacing (space-1): `p-5` is space-5. |
| `--space-16`          | `64px`               | 64px step.                                            | – A multiple of --spacing (space-1): `p-5` is space-5. |
| `--control-xs`        | `24px`               | Extra-small control height (IconButton xs).           | `--spacing-control-xs`                                 |
| `--control-sm`        | `28px`               | Small control height.                                 | `--spacing-control-sm`                                 |
| `--control-md`        | `32px`               | Default control height: buttons, inputs, selects.     | `--spacing-control-md`                                 |
| `--control-lg`        | `40px`               | Large control height.                                 | `--spacing-control-lg`                                 |
| `--row-compact`       | `36px`               | Compact table row height.                             | `--spacing-row-compact`                                |
| `--row-default`       | `44px`               | Default table row height.                             | `--spacing-row`                                        |
| `--row-relaxed`       | `52px`               | Relaxed table row height.                             | `--spacing-row-relaxed`                                |
| `--sidebar-width`     | `240px`              | Fixed sidebar width.                                  | `--spacing-sidebar`                                    |
| `--sidebar-collapsed` | `56px`               | Collapsed (icons-only) sidebar width.                 | `--spacing-sidebar-collapsed`                          |
| `--topbar-height`     | `56px`               | Sticky topbar height.                                 | `--spacing-topbar`                                     |
| `--page-padding`      | `24px`               | Padding around page content.                          | `--spacing-page`                                       |
| `--card-padding`      | `20px`               | Card body padding.                                    | `--spacing-card`                                       |
| `--content-max`       | `1440px`             | Maximum content width.                                | `--container-content`                                  |

### Radius

| Token           | Value (light / dark) | Usage                                                             | In Tailwind                                                                                       |
| --------------- | -------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `--radius-0`    | `0`                  | Square corners.                                                   | – `rounded-none`.                                                                                 |
| `--radius-xs`   | `2px`                | 2px: the rounding of chart bar tops.                              | – Reached through the radius roles: rounded-control, rounded-card, rounded-dialog, rounded-badge. |
| `--radius-sm`   | `4px`                | Badges and tooltips (radius-badge).                               | – Reached through the radius roles: rounded-control, rounded-card, rounded-dialog, rounded-badge. |
| `--radius-md`   | `6px`                | Controls: buttons, inputs, selects (radius-control).              | – Reached through the radius roles: rounded-control, rounded-card, rounded-dialog, rounded-badge. |
| `--radius-lg`   | `8px`                | Cards and menus (radius-card).                                    | – Reached through the radius roles: rounded-control, rounded-card, rounded-dialog, rounded-badge. |
| `--radius-xl`   | `12px`               | Dialogs and the sign-in card (radius-dialog).                     | – Reached through the radius roles: rounded-control, rounded-card, rounded-dialog, rounded-badge. |
| `--radius-full` | `999px`              | Pills (filter Tags, Switches) and circles (avatars, status dots). | `--radius-full`                                                                                   |

### Shadows and focus

| Token          | Value (light / dark)                                                                                                                      | Usage                                                                         | In Tailwind         |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------- |
| `--shadow-0`   | `none`                                                                                                                                    | No shadow: cards.                                                             | – `shadow-none`.    |
| `--shadow-1`   | `0 1px 2px rgba(16,16,15,.05)` / `0 0 0 1px rgba(255,255,255,.04)`                                                                        | Inputs and secondary buttons.                                                 | `--shadow-control`  |
| `--shadow-2`   | `0 4px 12px -2px rgba(16,16,15,.08), 0 1px 3px rgba(16,16,15,.05)` / `0 4px 12px -2px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.06)`    | Raised panels (sign-in card, raised Card).                                    | `--shadow-raised`   |
| `--shadow-3`   | `0 16px 40px -8px rgba(16,16,15,.18), 0 2px 6px rgba(16,16,15,.06)` / `0 16px 40px -8px rgba(0,0,0,.65), 0 0 0 1px rgba(255,255,255,.08)` | Anything floating: menus, tooltips, dialogs, drawers, toasts, chart tooltips. | `--shadow-floating` |
| `--focus-ring` | `0 0 0 3px rgba(242,61,15,0.3)`                                                                                                           | 3px ember ring at 30% on every focusable control, with border-focus.          | `--shadow-focus`    |

### Font weights

| Token               | Value (light / dark) | Usage                             | In Tailwind              |
| ------------------- | -------------------- | --------------------------------- | ------------------------ |
| `--weight-regular`  | `400`                | Body text.                        | `--font-weight-normal`   |
| `--weight-medium`   | `500`                | Labels, buttons, overlines.       | `--font-weight-medium`   |
| `--weight-semibold` | `600`                | Titles, metrics and the wordmark. | `--font-weight-semibold` |

### Font sizes

| Token        | Value (light / dark) | Usage                                     | In Tailwind                                                 |
| ------------ | -------------------- | ----------------------------------------- | ----------------------------------------------------------- |
| `--text-2xs` | `11px`               | Overlines, axis labels.                   | – Font sizes are set by the type-* roles, never one by one. |
| `--text-xs`  | `12px`               | Captions, hints.                          | – Font sizes are set by the type-* roles, never one by one. |
| `--text-sm`  | `13px`               | Dense UI, labels, small body.             | – Font sizes are set by the type-* roles, never one by one. |
| `--text-md`  | `14px`               | Body, card titles.                        | – Font sizes are set by the type-* roles, never one by one. |
| `--text-lg`  | `16px`               | Section titles.                           | – Font sizes are set by the type-* roles, never one by one. |
| `--text-xl`  | `18px`               | 18px step.                                | – Font sizes are set by the type-* roles, never one by one. |
| `--text-2xl` | `20px`               | 20px step.                                | – Font sizes are set by the type-* roles, never one by one. |
| `--text-3xl` | `24px`               | Page titles, small metrics.               | – Font sizes are set by the type-* roles, never one by one. |
| `--text-4xl` | `30px`               | Metrics.                                  | – Font sizes are set by the type-* roles, never one by one. |
| `--text-5xl` | `36px`               | Largest step; no display sizes beyond it. | – Font sizes are set by the type-* roles, never one by one. |

### Line heights

| Token              | Value (light / dark) | Usage                           | In Tailwind        |
| ------------------ | -------------------- | ------------------------------- | ------------------ |
| `--leading-tight`  | `1.15`               | Metrics and single-line titles. | `--leading-tight`  |
| `--leading-snug`   | `1.3`                | Labels.                         | `--leading-snug`   |
| `--leading-normal` | `1.5`                | Body.                           | `--leading-normal` |

### Letter spacing

| Token               | Value (light / dark) | Usage                                  | In Tailwind         |
| ------------------- | -------------------- | -------------------------------------- | ------------------- |
| `--tracking-tight`  | `-0.015em`           | Titles, metrics and the wordmark only. | `--tracking-tight`  |
| `--tracking-normal` | `0`                  | Everything else.                       | `--tracking-normal` |
| `--tracking-caps`   | `0.06em`             | Uppercase overlines.                   | `--tracking-caps`   |

### Border width

| Token            | Value (light / dark) | Usage                              | In Tailwind                        |
| ---------------- | -------------------- | ---------------------------------- | ---------------------------------- |
| `--border-width` | `1px`                | Every hairline and control border. | – Tailwind's `border` is this 1px. |

### Durations

| Token                | Value (light / dark) | Usage                     | In Tailwind        |
| -------------------- | -------------------- | ------------------------- | ------------------ |
| `--duration-instant` | `80ms`               | Button press.             | `duration-instant` |
| `--duration-fast`    | `120ms`              | Hover and colour changes. | `duration-fast`    |
| `--duration-base`    | `200ms`              | Menus and switches.       | `duration-base`    |
| `--duration-slow`    | `280ms`              | Drawers.                  | `duration-slow`    |

### Easings

| Token           | Value (light / dark)        | Usage                                | In Tailwind     |
| --------------- | --------------------------- | ------------------------------------ | --------------- |
| `--ease-out`    | `cubic-bezier(.2,.8,.2,1)`  | Default easing for every transition. | `--ease-out`    |
| `--ease-in-out` | `cubic-bezier(.65,0,.35,1)` | Symmetric moves.                     | `--ease-in-out` |

### Z-index

| Token          | Value (light / dark) | Usage                            | In Tailwind  |
| -------------- | -------------------- | -------------------------------- | ------------ |
| `--z-base`     | `0`                  | Base layer.                      | `z-base`     |
| `--z-sticky`   | `100`                | Sticky topbar and table headers. | `z-sticky`   |
| `--z-dropdown` | `200`                | Menus and selects.               | `z-dropdown` |
| `--z-drawer`   | `300`                | Drawers.                         | `z-drawer`   |
| `--z-modal`    | `400`                | Dialogs.                         | `z-modal`    |
| `--z-toast`    | `500`                | Toasts.                          | `z-toast`    |
| `--z-tooltip`  | `600`                | Tooltips.                        | `z-tooltip`  |

<!-- token-reference:end -->
