# Brand Identity

## Source of Truth — Read This First

TruePoint's brand assets live in two places. Read both before touching anything
brand-related. They are complementary, not redundant.

**`Guidelines/`** — the canonical brand kit folder in the codebase root. The
authoritative source is **`Guidelines/TruePoint Brand Kit.html`** (with
`docs/planning/brand-identity.md` as its planning-doc companion). It covers the logo
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

The TruePoint logo mark is a three-layer stacked diamond. Canonical inline SVG:

```jsx
<Svg size={17} sw={2.4}>
  <path d="M12 2 3 7l9 5 9-5-9-5Z"/>
  <path d="m3 17 9 5 9-5"/>
  <path d="M3 12l9 5 9-5"/>
</Svg>
```

`strokeLinecap="round"` `strokeLinejoin="round"` `fill="none"`
`stroke="currentColor"` `strokeWidth={2.4}`

### Logo Container (App Icon Treatment)

```jsx
<div style={{
  width: 30,
  height: 30,
  borderRadius: 8,
  background: 'var(--tp-cobalt)',
  display: 'grid',
  placeItems: 'center',
  color: 'var(--tp-surface)',
  flexShrink: 0,
}}>
  {/* logo mark SVG */}
</div>
```

Container sizes: sidebar `30×30px`, larger contexts scale proportionally.
`borderRadius` stays between `8` and `12` — never exceed `12`.

### Wordmark

```jsx
<span style={{
  fontFamily: 'var(--font-sans)',
  fontWeight: 600,
  fontSize: 15,
  letterSpacing: '-0.01em',
  color: 'var(--tp-ink)',
}}>TruePoint</span>
```

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

Geist (sans) and Geist Mono only. Both loaded automatically via the DS
stylesheet — no separate `@font-face` needed.

| Role | Size | Weight |
|---|---|---|
| Page title | 15px | 600 |
| Nav label active | 14px | 600 |
| Nav label inactive | 14px | 500 |
| Body / card | 14px | 400 |
| Table cell | 13px | 400 |
| Score / numeric | 13px | 600 + tabular-nums |
| Row subtitle | 11–12px | 400 |

### Iconography

All icons in `@leadwolf/ui` follow: `viewBox="0 0 24 24"`, `fill="none"`,
`stroke="currentColor"`, `strokeWidth={1.75}`, `strokeLinecap="round"`,
`strokeLinejoin="round"`. The canonical set:

```
IGrid, IUsers, IDeals, IContacts, IReports, ISettings, ISearch, IBell,
IPlus, IArrowUp, IArrowDn, IMail, IPhone, IPin, IBuilding, IStack,
IZap, IDots, ICalendar, ISave, IDownload, IUser, IReturn, IClose
```

Reuse existing icons for their designated semantics. New icons are defined
at the top of `@leadwolf/ui` with the `I` prefix, matching the same stroke
style. Check `Guidelines/` for any exported icon assets before drawing a
new one from scratch.
