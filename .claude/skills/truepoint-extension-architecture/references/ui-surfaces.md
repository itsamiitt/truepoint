# UI surfaces (side panel, popup, hover card)

The extension has three visual surfaces. This reference covers **where each surface lives and how it reuses
the design system**; anything about how a surface should *look or behave* (spacing, states, motion, copy,
accessibility) is `truepoint-design`'s call — read it before styling.

## The surfaces

| Surface | Path | Use | Notes |
|---|---|---|---|
| **Side panel** | `src/ui/panel/` | the primary workspace — contact/company cards, tabs, quick actions | Chrome Side Panel API; persists across tab navigation; has all extension APIs; opened from the popup or action |
| **Popup** | `src/ui/popup/` | auth status + quick entry ("Open workspace") | small; not a place for real work |
| **Hover card** | `src/content/hovercard/` | in-page trigger on a LinkedIn profile | injected; Shadow-DOM isolated; vanilla DOM (tiny bundle) — see `truepoint-extension-linkedin/references/hovercard.md` |

**Prefer the Side Panel API over an injected sidebar.** It renders without host permissions, keeps our UI out
of LinkedIn's DOM (less breakage, less fingerprint surface), persists across tab switches, and has full API
access. Inject into the page only for the minimal hover trigger.

## Design-system reuse — tokens only

- Import `@leadwolf/ui/tokens.css` for panel/popup pages (via `src/ui/brand.css`); for the Shadow-DOM hover
  card, inline it: `import tokens from "@leadwolf/ui/tokens.css?inline"` and inject into the shadow root.
- Style with `var(--tp-*)` (surfaces, ink, cobalt brand, radius, motion, z-index, spacing). The tokens are
  framework-agnostic and Vite-consumable — this is proven and is the sanctioned reuse path.
- **Do not** import the `@leadwolf/ui` React component barrel's `components/ui/*` (shadcn) family — those emit
  Tailwind utility classes and need Tailwind at consume-time, which the extension build does not run. The
  portable inline-styled primitives (`Card`, the State Kit) *can* be reused if desired, but tokens-only is the
  default.
- Self-host fonts (Geist woff2 in `src/assets/fonts/`); the CSP blocks remote fonts.

## Rules

- **Every data surface implements the four states** (loading, empty, error-with-retry, data) — the panel's
  "Captured" tab is the reference; new tabs must not ship as bare `EmptyState` placeholders. Defer the exact
  state visuals to `truepoint-design`.
- **Surfaces are thin clients.** They `send()` a bus message and render the typed result; they never call the
  API or hold a token.
- Keep panel/popup bundles small; heavy logic belongs in the SW.
