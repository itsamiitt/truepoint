# Wireframe — web Plan change (upgrade / downgrade / cancel)

> Portal: `apps/web` · Owned by `05_Web_Experience.md` · IA placement: hub Plan/Subscription tabs
> (`03 §6.2`). Flows: `03 §7.2` (proration preview), `03 §7.6/§7.7` (cancel export-first).
> Primitives (existing only): `StatTile`, `StatusBadge`, `StateSwitch`, `EmptyState`, `Skeleton`.
> Gating: **`[decision-gated]` — proposed `ADR-0041`; NOT BUILT** (`02 §3.5`). ws-admin only (OD-8).

---

## Upgrade / downgrade — with proration preview

```
LOADING: [▒▒▒▒] preview skeleton   ERROR: ⚠ {title}/{detail} [Retry]
DATA:
┌──────────────────────────────────────────────────────────────────────────┐
│ Change plan                                            (ws-admin only OD-8)│
├──────────────────────────────────────────────────────────────────────────┤
│  Current: Pro          →   Select target:  [ Enterprise ▾ ]               │
├──────────────────────────────────────────────────────────────────────────┤
│  PRORATION PREVIEW  (read-only estimate — no charge yet)  [decision-gated] │
│  ┌────────────────────┐ ┌────────────────────┐                           │
│  │ Today's charge     │ │ Effective date     │   (StatTiles)             │
│  │ +$140 (prorated)   │ │ 2026-07-01         │                           │
│  └────────────────────┘ └────────────────────┘                           │
│   Seats: 5 → ∞      Monthly grant Δ: +45,000 (when grant job exists)      │
│   "Month-to-month — no auto-renewal unless you opt into annual (LD-1)."   │
├──────────────────────────────────────────────────────────────────────────┤
│                                   [ Cancel ]   [ Confirm change ]         │
└──────────────────────────────────────────────────────────────────────────┘
EMPTY (no other plan available): (EmptyState) "You're on the highest plan."
```

> Preview is fetched **before** confirm (`03 §7.2`); confirm sends an Idempotency-Key. **Defer-
> honest:** entire surface disabled until proposed `ADR-0041` ships.

---

## Cancel — export-first, NO data-destroy (`ADR-0012`, `03 §7.6/§7.7`)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Cancel plan                                            (ws-admin only OD-8)│
├──────────────────────────────────────────────────────────────────────────┤
│ Step 1 — Export your data (ALWAYS offered first)                          │
│   [ Export credit history / usage / invoices ]  → flow 03 §7.7            │
│   StatusBadge: [export ready] when the signed link is built               │
├──────────────────────────────────────────────────────────────────────────┤
│ Step 2 — Confirm cancel                                                   │
│   "Your data is RETAINED (ADR-0012 — no destroy on churn). Remaining      │
│    credits DO NOT expire. You drop to month-to-month / free."            │
│                                   [ Keep plan ]   [ Confirm cancel ]      │
└──────────────────────────────────────────────────────────────────────────┘
```

> No dark patterns: export is offered **before** the confirm; cancel performs **no** destructive
> action (`ADR-0012`). Disabled until proposed `ADR-0041`.

---

## Permission-aware rendering / WCAG 2.2 AA / Responsive

- Change/Cancel gated by workspace-admin (OD-8); non-admins see "ask a workspace admin", controls
  disabled. API enforces.
- Destructive confirm requires explicit click; proration `StatTile`s have text labels; `aria-live`
  on preview updates. Focus-visible; labels bound. Currency text "USD" (OD-5).
- ≥1024px: preview tiles in a row. <768: stacked; the change/cancel panels are full-screen sheets.
