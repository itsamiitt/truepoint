# Wireframe — web `/settings/billing` (Billing HUB, tabbed)

> Portal: `apps/web` · Owned by `05_Web_Experience.md` · IA placement: `03 §6.2` (OD-3 one hub).
> Primitives (existing only): `StatTile`, `DataTable`, `Progress`, `StatusBadge`, `StateSwitch`,
> `EmptyState`, `Skeleton`. Web is vanilla React + `fetchWithAuth` + `StateSwitch` + `MaybeList`
> (NOT TanStack Query — project memory). Default tab: **Credits**. Deep-link `?tab=…` (`03 §6.2`).

---

## Tab bar (the hub)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Billing   [ Plan ] [ Credits* ] [ Usage ] [ Invoices ] [ Subscription ]  │  ← *default
└──────────────────────────────────────────────────────────────────────────┘
   On <768: tabs collapse to a [ Section ▾ ] select.
```

---

## Tab: PLAN  `[exists-partial]`

```
LOADING: [▒▒▒▒][▒▒▒▒][▒▒▒▒]   ERROR: ⚠ {title}/{detail} [Retry]
DATA:
┌────────────┐ ┌────────────┐ ┌────────────┐
│ Plan       │ │ Seats      │ │ Workspaces │   (StatTiles — [exists] 02 §3.5)
│ Pro        │ │ 4 / 5      │ │ 2 / 3      │
└────────────┘ └────────────┘ └────────────┘
[ Change plan ]   ← workspace-admin only (OD-8); [decision-gated], → plan-change.md
   (plan data via GET /tenants/me — null-tolerant "not built yet", 02 §3.5)
```

## Tab: CREDITS  `[exists-partial]` (DEFAULT)

```
DATA:
┌──────────────────────────────────────────────────────────┐
│ Balance                                                  │
│   18,420 credits          [ Top up ]  ← ws-admin (OD-8)  │  [Stripe]
│   (low-balance banner if < 20 — amber + icon + text)     │
│   "Charged only for verified data; bounces credited      │
│    back (ADR-0013). Credits don't expire (ADR-0012)."    │
├──────────────────────────────────────────────────────────┤
│ [ Top up ] → POST /credits/checkout [Stripe — NOT BUILT] │
│    today: toasts "Top-up coming soon" (02 §3.5)          │
├──────────────────────────────────────────────────────────┤
│ Allocation entry → [ Manage team budgets ]               │
│    [M12-lease][decision-gated] → allocation.md           │
│    (disabled until M12; tenant pool authoritative LD-2)  │
└──────────────────────────────────────────────────────────┘
EMPTY (no balance/tenant): (EmptyState) "Billing not set up yet."
```

## Tab: USAGE  `[exists-partial]`

```
DATA  (DataTable — flat capped today; paginate/filter/export = target 02 §3.5):
  Date         User        Reveal type     Credits   Source
  ──────────────────────────────────────────────────────────
  2026-06-29   alice@…     full_profile    3         apollo
  2026-06-28   bob@…       email           1         internal
  [ Filter ▾ ]  [ Export CSV ]   ← pagination/filter/export = [exists-partial] target
EMPTY: (EmptyState) "No reveals yet."
```

## Tab: INVOICES  `[Stripe][flag]`

```
(EmptyState) "Invoices & receipts arrive with billing."   ← NOT BUILT (02 §3.5/§9.1)
  target: DataTable {Date, Amount, Status(StatusBadge), [Download PDF]} — ws-admin read (OD-8)
```

## Tab: SUBSCRIPTION  `[decision-gated]`

```
(EmptyState) "You're on month-to-month — no auto-renewal (ADR-0012)."
  target: term/renewal StatTile + [ Cancel plan ] (export-first, no destroy — 03 §7.6/§7.7)
  Cancel = ws-admin only (OD-8); proposed ADR-0041. Auto-renew NEVER defaulted-on (LD-1).
```

> **Defer-honest:** Invoices, Subscription, and Allocation render `EmptyState`/disabled with honest
> copy; Top-up is the documented stub (`02 §3.5`). No fabricated invoices, charges, or balances.

---

## Permission-aware rendering (OD-8 — workspace-admin)

| Control | Gate |
|---|---|
| Read balance / usage | any workspace member |
| **Top up** | workspace-admin only |
| **Change plan** / **Cancel** | workspace-admin only |
| **Manage allocation** | workspace-admin only |
| Invoices read | workspace-admin only |

Non-admins see read surfaces; gated actions render disabled with "ask a workspace admin".

## WCAG 2.2 AA / Responsive

- Low-balance state = amber + warning icon + text (never color-only); `aria-live=polite` on balance
  after a `window:credits:changed` refresh (`02 §3.5`). Tabs are a proper tablist
  (`role=tab`/`aria-selected`, arrow-key nav), focus-visible. `DataTable` headers `scope`.
- ≥1024px: 3-col tiles. 768–1023: 2-col. <768: 1-col; tab bar → `Section ▾` select; tables → cards.
