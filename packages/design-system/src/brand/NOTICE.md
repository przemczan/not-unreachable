# Brand: notice

## The logo

NotUnreachable's logo is an original work made for NotUnreachable: a lowercase
"nu" drawn as one unbroken route that ends at a node, in the accent colour on a
rounded square. No icon set, typeface glyph or other logo was drawn from. It is
part of this repository and is covered by the repository's licence. The
repository has no licence file yet.

Its drawing lives in `mark.ts`. `<Logo />` draws it inline, and
`scripts/render-brand-icons.ts` (`pnpm brand-icons`) writes every static file in
this folder from it: `logo-mark.svg`, `logo-mark-dark.svg`, `logo-mark-mono.svg`,
`favicon.svg`, `logo-lockup.svg`, `logo-lockup-dark.svg`, `apple-touch-icon.png`
and `icon-512.png`.

## The name in the lockups

In `logo-lockup.svg` and `logo-lockup-dark.svg`, the name "NotUnreachable" is
drawn as outlines of Geist SemiBold, taken from `../fonts/Geist-Variable.woff2`.
Geist is Copyright 2026 The Geist Project Authors (the vercel/geist-font
project) and is used under the SIL Open Font License, Version 1.1. The licence's
full text is in `../fonts/OFL.txt`.

In the app, the name is live text in Geist (`<Wordmark />`), not outlines.
