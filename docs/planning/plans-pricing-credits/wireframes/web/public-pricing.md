# Wireframe — web `/pricing` (PUBLIC, unauthenticated pricing page)

> Portal: `apps/web` · Owned by `05_Web_Experience.md` · IA placement: `03 §6.2`.
> Primitives (existing only): `StatTile`, `StatusBadge`, `StateSwitch`, `EmptyState`, `Skeleton`.
> Gating: **`[Stripe]`/none — NOT BUILT** (no unauth route exists today, `02 §3.5`).
> **Render contract:** NO token, NO tenant, NO balance — never calls `/credits/balance` (`03 §6.2`).

---

## State: LOADING / ERROR / EMPTY

```
LOADING:  [▒▒▒▒] [▒▒▒▒] [▒▒▒▒]  ← Skeleton tier cards
ERROR:    ⚠ Couldn't load pricing — {title}/{detail}    [ Retry ]
EMPTY:    (EmptyState) "Pricing is being updated — check back soon."
```

## State: DATA

```
┌──────────────────────────────────────────────────────────────────────────┐
│  TruePoint — Pricing            (PUBLIC · no sign-in required)            │
│  Transparent, no lock-in. Prices in USD.   ← ADR-0012; OD-5 USD authoritative│
├──────────────────────────────────────────────────────────────────────────┤
│  PLANS  (StatTile-style tier cards — from PUBLIC pricing read, no PII)    │
│  ┌────────────┐  ┌────────────┐  ┌────────────────┐                      │
│  │ Free       │  │ Pro        │  │ Enterprise     │                      │
│  │ $0         │  │ $79 / mo*  │  │ Custom         │                      │
│  │ 1 seat     │  │ 5 seats    │  │ ∞ seats        │                      │
│  │ 1 ws       │  │ 3 ws       │  │ ∞ ws           │                      │
│  │ [Get       │  │ [Get       │  │ [Contact sales]│                      │
│  │  started]  │  │  started]  │  │                │                      │
│  └────────────┘  └────────────┘  └────────────────┘                      │
│   * month-to-month, NO auto-renew by default (LD-1). No annual lock.      │
├──────────────────────────────────────────────────────────────────────────┤
│  CREDIT PACKS  (top-ups, buy after sign-up)                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐                                 │
│  │ Starter  │ │ Growth   │ │ Scale    │                                 │
│  │ 1,000 cr │ │ 5,000 cr │ │ 25,000   │                                 │
│  │ $19      │ │ $79      │ │ $299     │                                 │
│  └──────────┘ └──────────┘ └──────────┘                                 │
├──────────────────────────────────────────────────────────────────────────┤
│  Reassurance: "Charged only for verified data; bounces credited back     │
│   (ADR-0013). Credits don't expire. Your data is never destroyed if you  │
│   leave (ADR-0012)."                                                     │
├──────────────────────────────────────────────────────────────────────────┤
│  CTA row:   [ Get started → sign up ]      [ Sign in ]                    │
│   No in-page purchase (purchase needs auth + workspace-admin, OD-8).     │
└──────────────────────────────────────────────────────────────────────────┘
```

> **Defer-honest:** this surface does not exist today (`02 §3.5` NOT-built list). It reads a
> **public pricing endpoint** (catalog only — active `credit_packs` + `plan_templates`, no PII,
> `02 §9.1`), never the authenticated balance.

---

## Permission-aware rendering

- **No auth context at all.** No `useStaffMe`, no workspace role, no `fetchWithAuth` to a tenant
  route. CTAs route to sign-up / sign-in only.

## WCAG 2.2 AA / Responsive

- Tier cards are landmarks with headings; price is text (not image). "Most popular" emphasis (if
  any) is text + border, not color-only. CTA buttons ≥ 24px target, focus-visible, descriptive
  labels ("Get started with Pro").
- ≥1024px: 3-up tiers + 3-up packs. 768–1023: 2-up wrap. <768: single-column stacked cards; CTAs
  full-width.
