# Wireframe — admin `/pricing` (Credit-pack catalog)

> Portal: `apps/admin` · Owned by `04_Admin_Experience.md` · IA placement: `03 §6.1`.
> Primitives (existing only): `DataTable`, `StatusBadge`, `StateSwitch`, `EmptyState`, `Skeleton`.
> Capability: **`pricing:manage`** (write). Reuses pricing tab audit `05-pricing.md` gap IDs.

---

## State: LOADING / EMPTY / ERROR

```
LOADING:  ▒▒▒▒▒▒▒▒▒▒▒  ← Skeleton rows
EMPTY:    (EmptyState) No credit packs yet.   [+ New pack]   ← gate pricing:manage
ERROR:    ⚠ Couldn't load packs — {title}/{detail}    [ Retry ]
```

## State: DATA

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Pricing (credit_packs catalog — [exists] 02 §3.4)         [+ New pack]    │  ← gate pricing:manage
├──────────────────────────────────────────────────────────────────────────┤
│  Key        Name        Credits   Price     Currency   Active   Actions   │
│  ──────────────────────────────────────────────────────────────────────  │
│  starter    Starter      1,000    $19       USD*       [On]    [Edit]     │
│  growth     Growth       5,000    $79       USD*       [On]    [Edit]     │
│  scale      Scale       25,000    $299      USD*       [Off]   [Edit]     │
│   * single-currency by schema — no `currency` column (02 §3.1.3). USD     │
│     authoritative (OD-5). Currency col = [decision-gated] placeholder.    │
├──────────────────────────────────────────────────────────────────────────┤
│  EDIT PANEL (per pack)                                                    │
│   Credits [____]   Price (cents) [____]   Active [On/Off]                 │
│   ── Effective-date scheduling / price-change sim [exists-partial 05-prc] │
│      "Schedule change for [date] — preview impact" (disabled until built) │
│   ── Multi-currency / price history  [decision-gated — OD-5]             │
│      (disabled; USD authoritative until international GTM)                │
│   ── Promotions / coupons  [decision-gated]                              │
│      (disabled; no promotions table — 02 §9.1)                           │
│                                          [ Cancel ]  [ Save ]            │
├──────────────────────────────────────────────────────────────────────────┤
│  Note: retired pack = Active Off (kept for history, 02 §3.1.8).          │
│  NO customer-facing read wired here — public pricing is a SEPARATE web   │
│  surface (03 §6.2), not this admin catalog.                              │
└──────────────────────────────────────────────────────────────────────────┘
```

> **Defer-honest:** currency column, scheduling, multi-currency, and promotions render **disabled**
> with honest notes — `[decision-gated]`/`[exists-partial]`, not built. Prices are placeholders
> (`ADR-0012`).

---

## Permission-aware rendering

- All write controls gated by `useStaffMe().canMaybe("pricing:manage")`; API enforces
  (`02 §3.2.3`, audit `credit_pack.set`). Read-only staff see the catalog, no controls.

## WCAG 2.2 AA / Responsive

- Active = `StatusBadge` with text. Price inputs labeled, numeric, with `inputmode`. Currency shown
  as text ("USD"), never flag-color-only. Save/Cancel focus-visible.
- ≥1024px full table; <768 → card rows; edit panel → full-screen sheet.
