# Brand Identity

## Source of Truth — Read This First

TruePoint's brand assets live in two places. Read both before touching anything
brand-related. They are complementary, not redundant.

**`Guidelines/`** — the canonical brand kit folder in the codebase root. The
authoritative source is **`Guidelines/TruePoint Brand Kit.html`**. (Its old
planning-doc companion `docs/planning/brand-identity.md` is **superseded** — trust
only the corrected facts in its header banner, never its legacy body.) It covers the logo
files, icon exports, colour definitions, typography specimens, spacing rules, usage
guidelines, and any other brand documentation the design team maintains. Before
making any brand-level decision — logo placement, colour use, typography,
iconography — read the relevant file in `Guidelines/` first.

**`@leadwolf/ui`** — the code implementation of the brand in the design system.
The logo mark is a component, the wordmark a component, the icon set exported icon
components, and the brand tokens part of the single shared token source. These
implementations must stay consistent with the `Guidelines/` definitions. If they
ever conflict, `Guidelines/` wins.

> Earlier material located these in a single prototype file. The real home is the
> `@leadwolf/ui` package (real path `packages/ui`, imported normally — see the design
> skill SKILL.md). Where this file refers to "the implementation in `@leadwolf/ui`",
> read the corresponding `packages/ui` component/token. The brand is implemented
> **once** in the design system and imported, never re-drawn per surface or per app.

**When working on any surface that shows brand elements:**
1. Open `Guidelines/` and read the relevant guideline file
2. Implement using the exact values specified there
3. Cross-reference `@leadwolf/ui` for the established code pattern
4. Never approximate, never invent, never substitute

---

## What Lives in `Guidelines/`

The `Guidelines/` folder contains the complete TruePoint brand kit. Expect to
find some or all of the following — read the actual files rather than assuming
the content:

- Logo files (SVG, PNG) in all variants: full lockup, mark only, wordmark only,
  light and dark versions, monochrome versions
- Colour palette with exact values, usage rules, and do/don't examples
- Typography specimen showing typeface, weights, sizes, and pairing rules
- Spacing and grid system
- Icon set exports and usage guidelines
- Brand voice and tone (if present)
- Component usage examples showing correct brand application

Always read the specific guideline file that covers what you are building.
Do not skim — brand rules contain important constraints on minimum sizes,
clear space, prohibited combinations, and approved colour pairings that are
easy to violate by approximation.

---

## Code Implementation Reference

The following is how brand elements are implemented in `@leadwolf/ui`.
These patterns must match the `Guidelines/` specs — if the specs call for
something different, update the code to match.

### Logo Mark

The TruePoint logo mark is **three rising chevrons** — only the apex chevron in
Cobalt, the lower two in ink. The canonical implementation is `Brandmark` in
`apps/web/src/components/shell/Logo.tsx` (Brand Kit v1.0) — reuse/copy it, never
redraw or approximate:

```jsx
// Logo.tsx — canonical geometry (viewBox 0 0 100 100, fill="none", rounded caps/joins)
<path d="M22 43 L50 28 L78 43" stroke={accent} />  // apex — var(--tp-cobalt)
// …two lower chevrons in currentColor (ink); `reversed` variant for dark backgrounds
```

Exact paths, stroke width, and spacing live in `Logo.tsx` and
`Guidelines/TruePoint Brand Kit.html` — read them before placing the mark. App-icon
treatments come from the exported assets in `Guidelines/assets` — don't hand-build
containers.

### Wordmark

The wordmark is **two-weight**: "True" at weight 400 + "Point" at 700–800, one
colour — never a single uniform weight. Canonical implementation: `Wordmark` in
`apps/web/src/components/shell/Logo.tsx`; the spec is in the Brand Kit.

### Brand Colour

| Token | Resolved value | Use for |
|---|---|---|
| `--tp-cobalt` | `#2563c9` | Primary fill, icon container, active indicator |
| `--tp-cobalt-700` | `#1e4fa3` | Active nav text, accent text |
| `--tp-cobalt-50` | `#e9f0fc` | Active nav tint, hover backgrounds |
| `--tp-cobalt-tint` | `#5b8def` | Lighter highlight, focus rings |

Never hardcode hex. Always use the token. Cobalt is never used as body text
on a white background — fills and active states only.

### Typography

Geist (sans) and Geist Mono only — **self-hosted per app via next/font** (the
`geist` package): each app's root layout imports `GeistSans`/`GeistMono` and sets
`--font-geist-*` on `<html>` (see `apps/web/src/app/layout.tsx`); the DS stylesheet
supplies only the fallback stacks. A new app must wire this itself — nothing loads
the fonts "automatically".

| Role | Size | Weight |
|---|---|---|
| Page title | 16px | 600 |
| Nav label active | 14px | 600 |
| Nav label inactive | 14px | 500 |
| Body / card | 14px | 400 |
| Table cell | 13px | 400 |
| Score / numeric | 13px | 600 + tabular-nums |
| Row subtitle | 11–12px | 400 |

### Iconography

Icons are **lucide-react glyphs rendered through the DS `Icon` wrapper**
(`@leadwolf/ui`): consistent `strokeWidth 1.75` default, sized by context (see
tokens.md). Pick an existing lucide glyph for the semantic you need — do not
hand-draw SVGs or introduce a parallel icon set; the logo mark (`Logo.tsx`) is the
only custom-drawn SVG. Check `Guidelines/` for exported icon assets before
introducing a new glyph.

```jsx
import { Icon } from '@leadwolf/ui'
import { Phone } from 'lucide-react'

<Icon icon={Phone} size={16} label="Call" />
```
