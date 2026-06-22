# Brand Identity — TruePoint (formerly LeadWolf)

> [!IMPORTANT]
> **Superseded — the product is now _TruePoint_, not _LeadWolf_.** The authoritative brand source is
> [`Guidelines/TruePoint Brand Kit.html`](../../Guidelines/TruePoint%20Brand%20Kit.html) and the live design
> tokens in [`packages/ui/src/tokens.css`](../../packages/ui/src/tokens.css). The corrected canonical facts
> below **override** the legacy text that follows:
> - **Name:** TruePoint. The wordmark is "True" (weight 400) + "Point" (weight 700–800), one color.
> - **Mark:** three stacked chevrons converging on an apex — the apex stroke is Cobalt, the rest is ink.
> - **Accent — Cobalt `#2563C9`** (`--tp-cobalt`): fills / mark / accents **only, never body text**. The old
>   "Wolf-Indigo" `#4F46E5` is **retired** repo-wide.
> - **Primary button = Ink `#111827`** (`--tp-btn`), not the accent.
> - **Type:** Geist + Geist Mono. **Light theme only.**
>
> The "LeadWolf" name and wolf metaphor in the sections below are retained for historical context only.

> The brand system. It is deliberately the *same* visual language as the product
> ([04-ui-ux-design.md](./04-ui-ux-design.md)): **clean, light, near-monochrome**, with one restrained
> accent. Quiet confidence, not loud sales-tech.

## 1. Name & meaning

**LeadWolf** = **lead** (the sales prospect — and *to lead*) + **wolf** (a precise, relentless pack
hunter). A wolf pack tracks the *right* target with patience and coordination, then moves decisively —
exactly how a sales team should prospect. "Lead wolf" is also the one that **leads the pack**.

- **What it says:** intelligent, precise, relentless prospecting — done as a pack (teams / workspaces).
- **What it avoids:** cheesy "howling-at-the-moon" wolf clichés, dark/edgy gimmickry, hype.

## 2. Positioning

> **The intelligent prospecting CRM** — find the right people, reveal verified contact details, score
> them, and engage them, as a coordinated pack.

- **Category:** sales-intelligence + prospecting CRM (per-workspace).
- **For:** SDRs, AEs, and RevOps teams who want clean data and an end-to-end workflow in one place.
- **Against:** bloated legacy data vendors and stitched-together tool stacks.
- **Proof points:** verified-on-reveal data, per-workspace control, compliance built into the core,
  find → reveal → score → sequence → send without leaving the app.

## 3. Brand essence & personality

**Essence:** *Precise. Relentless. Clean.*

| Trait | Means | Shows up as |
|---|---|---|
| **Precise** | accurate data, sharp UI, no clutter | monochrome surfaces, exact copy, verified contacts |
| **Relentless** | pursues the right lead, never the spray-and-pray | sequences, scoring, the "hunt" metaphor (sparingly) |
| **Intelligent** | scoring, enrichment, signal-driven | quiet sophistication, data-forward |
| **Trustworthy** | compliance-first, data ownership | calm tone, transparency, no dark patterns |
| **Modern** | fast, keyboard-first, lean | single-page command center, `cmdk` |

**Archetype:** the Hunter / the Sage-Hunter — capable and composed, not aggressive.

## 4. Voice & tone

- **Direct and precise** — short sentences, concrete verbs, minimal jargon.
- **Calm-confident** — we know our stuff; we don't shout. No exclamation-mark spam.
- **Helpful, not hypey** — explain the value, skip the buzzwords ("synergy", "10x", "game-changer").
- **Pack, not predator** — collaborative ("your team", "your pack"), never creepy about surveillance.

**Words we use:** find, reveal, score, pursue, pack, signal, verified, clean.
**Words we avoid:** scrape, harvest, blast, spray, stalk, ping-everyone.

**Microcopy examples**
- Empty search: *"No matches yet. Adjust your filters and let's track them down."*
- Reveal confirm: *"Reveal Jane Doe — 1 credit. Balance after: 1,239."*
- Low credits: *"Running low — 12 credits left."* (warning accent, no alarm)

## 5. Tagline options

1. **"Hunt your best leads."**  *(primary candidate)*
2. "Lead the pack."
3. "Find. Reveal. Pursue."
4. "Smarter prospecting. Cleaner data."
5. "Prospect like a pack."

## 6. Logo

**Wordmark:** `LeadWolf` set in the product typeface (Geist / Inter), tight tracking. Set "Lead" in
**Regular** and "Wolf" in **Semibold** to give a subtle, single-color emphasis shift — *no* second color.

**Mark (glyph):** a **minimal, geometric wolf head** built from a few straight strokes — two angular ears
that read as an upward chevron (a quiet nod to *lead / rising*), a clean snout. Monochrome, single weight,
works at 16px (favicon) up to billboard. It can double as the app icon and social avatar.

```
   ▲ ▲        ears = upward chevrons ("lead / up")
  ╱   ╲
 ╱  •  ╲      single accent dot allowed (the "eye") — optional, sparing
 ╲ ___ ╱      clean geometric snout
```

**Lockups:** (a) glyph + wordmark horizontal; (b) glyph only (icon); (c) wordmark only.
**Clearspace:** ≥ the height of the "L" on all sides. **Min size:** glyph 16px; wordmark 80px wide.

**Don'ts:** no gradients, no drop shadows, no recoloring outside the palette, no stretching/rotating, no
photographic wolves, no outline+fill mixing.

## 7. Color

Brand color **is** the product palette ([04 §2](./04-ui-ux-design.md)) — fundamentally **monochrome**,
with **one** primary accent used sparingly and semantic colors reserved for status.

| Role | Token | Hex | Use |
|---|---|---|---|
| Canvas | `--bg-content` | `#FFFFFF` | primary surface |
| Sidebar / muted surface | `--bg-sidebar` | `#F9FAFB` | nav, panels |
| Hairline | `--border-hairline` | `#F0F0F0` | dividers, separation |
| Border | `--border-default` | `#E5E7EB` | inputs, cards |
| Text — primary | `--text-primary` | `#111827` | near-black, headings/body |
| Text — secondary | `--text-secondary` | `#6B7280` | muted grey, labels/icons |
| **Accent — "Cobalt"** | `--tp-cobalt` | `#2563C9` | **rare**: fills, the mark apex, active emphasis — **never body text**. The primary CTA is Ink (`--tp-btn` `#111827`), not the accent. |
| Success | `--success` | `#16A34A` | verified email, healthy |
| Warning | `--warning` | `#D97706` | low credits, risky email |
| Danger | `--danger` | `#DC2626` | invalid, destructive |

**The accent rule:** color is *earned*. ~90% of any screen is monochrome; **Cobalt** appears only as a *fill*
on the single most important action or state (and on the mark apex) — never as body text. The accent lives in
this deep **cobalt** tone — *not* in a dark theme (a dark "dusk" UI was explicitly rejected, see
[04](./04-ui-ux-design.md)).

## 8. Typography

- **Primary:** **Geist** (fallback **Inter**) — UI + marketing. Headings Semibold (tight tracking), body
  Regular. Sizes per [04 §2](./04-ui-ux-design.md) (13px dense tables, 14px body, 16–20px headings).
- **Mono:** **Geist Mono** / JetBrains Mono — data, code, IDs, credit counts.
- **Hierarchy through weight + size, not color.**

## 9. Iconography & imagery

- **Icons:** **Lucide** — thin, geometric, muted grey, matching nav weight. The wolf motif lives **only**
  in the logo; don't sprinkle wolf icons through the UI.
- **Illustration:** minimal monochrome line work; generous whitespace; a single accent highlight at most.
- **Imagery:** abstract/geometric or product screenshots — never stock wolf photography.
- **Data viz (Reports):** monochrome series with the accent reserved for the highlighted/primary series;
  semantic colors only for status (deliverability, verification).

## 10. Applications

- **App:** favicon/app icon = the wolf glyph; the established light shell ([11](./11-information-architecture.md));
  accent only on the primary CTA + the credit pill's low/active state.
- **Marketing site:** same light/monochrome system; large type, lots of whitespace, product screenshots.
- **Email (SES / React Email):** monochrome templates, single accent CTA button, wordmark in header,
  physical-address + unsubscribe footer ([08 §6](./08-compliance.md)).
- **Social / avatar:** glyph on `#111827` *or* `#FFFFFF` (the one place the glyph may sit on near-black).

## 11. Quick-reference (the 10-second brand)

- **Name:** TruePoint — precise, signal-driven prospecting for the right leads.
- **Look:** clean light monochrome + one Cobalt accent (fills only, never text).
- **Voice:** direct, calm-confident, jargon-free.
- **Tagline:** *Hunt your best leads.* *(legacy — pending a TruePoint tagline)*
- **Type:** Geist / Geist Mono. **Icons:** Lucide. **Accent:** Cobalt `#2563C9` (fills only); **buttons:** Ink `#111827`.

## 12. Open items
1. Final tagline selection (§5).
2. Commission the wolf glyph (this doc specifies the construction; needs a designer to execute).
3. Confirm **Geist vs Inter** as primary typeface (both fit; Geist is more distinctive).
4. Logo files + brand kit (SVG glyph, lockups, favicon set) — a build-time asset task.
