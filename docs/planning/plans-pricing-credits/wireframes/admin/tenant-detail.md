# Wireframe — admin `/tenants/:id` (Per-tenant money ops)

> Portal: `apps/admin` · Owned by `04_Admin_Experience.md` · IA placement: `03 §6.1`.
> Primitives (existing only): `StatTile`, `DataTable`, `Progress`, `StatusBadge`, `StateSwitch`,
> `EmptyState`, `Skeleton`. Capabilities: **`tenants:credits`** (credit/refund/suspend, JIT-gated),
> **`tenants:plan`** (plan override), **`billing:read`** (purchases/ledger read).

---

## State: LOADING / EMPTY / ERROR

```
LOADING:  [▒▒▒▒] [▒▒▒▒] [▒▒▒▒]  +  ▒▒▒▒▒▒ rows   ← Skeleton tiles + tables
EMPTY:    (EmptyState) No purchases for this tenant yet.
ERROR:    ⚠ Couldn't load tenant — {title}/{detail}    [ Retry ]
```

## State: DATA

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Tenant · Acme Corp                              [StatusBadge: active]      │
├──────────────────────────────────────────────────────────────────────────┤
│ ┌────────────┐ ┌────────────┐ ┌────────────┐                             │
│ │ Balance    │ │ Plan       │ │ Seats      │   (StatTiles — [exists])     │
│ │ 18,420 cr  │ │ pro        │ │ 4 / 5      │                             │
│ └────────────┘ └────────────┘ └────────────┘                             │
├──────────────────────────────────────────────────────────────────────────┤
│ ACTIONS  (TenantActions — [exists] 02 §3.4, capability-gated)             │
│  [ Adjust credits ]   ← tenants:credits + JIT credit.adjust elevation     │
│      Δ [ +/- ____ ]  Reason [__________ (required)]                       │
│      (would-overdraw debit → 422; FOR UPDATE + CHECK>=0 guards, 02 §3.2.4)│
│  [ Apply plan ▾ ]     ← tenants:plan; loads active templates; plan.override│
│      (does NOT grant credits — monthly grant job doesn't exist, 02 §3.2.4)│
│  [ Suspend ]          ← tenants:credits + JIT tenant.suspend elevation     │
├──────────────────────────────────────────────────────────────────────────┤
│ PURCHASES  (DataTable newest-first ≤100 — [exists])                       │
│  Date         Credits   Amount    Status        Action                    │
│  ───────────────────────────────────────────────────────────────────────│
│  2026-06-20   5,000     $79       [completed]    [ Refund ]  ← tenants:credits│
│  2026-05-18   1,000     $19       [refunded]      —                        │
│   Refund reverses credits CLAMPED to balance; remainder deferred to M11   │
│   ledger reconciliation (02 §3.2.4). Stripe ids NOT projected.            │
├──────────────────────────────────────────────────────────────────────────┤
│ CREDIT LEDGER (per-tenant)  [M11-ledger — 03 §6.1]                        │
│  (EmptyState) "Per-event credit ledger arrives with M11 (ADR-0029).      │
│   Today the balance is a bare counter — no event trail (02 §3.1.1)."     │
├──────────────────────────────────────────────────────────────────────────┤
│ INVOICES + SUBSCRIPTION STATE  [Stripe][decision-gated]                   │
│  (EmptyState) "Invoices & subscription state arrive with billing."       │
├──────────────────────────────────────────────────────────────────────────┤
│ ALLOCATION OVERSIGHT (team/user budgets)  [M12-lease][decision-gated]     │
│  (EmptyState) "Hierarchical allocation arrives with M12 leases           │
│   (proposed ADR-0042). Tenant pool stays authoritative (LD-2)."          │
│  ── target render (read-only, when built): ──                            │
│  Team        Budget    Used                                              │
│  Sales       8,000     [Progress ███████░░ 72%]                          │
│  Marketing   4,000     [Progress ████░░░░░ 40%]                          │
└──────────────────────────────────────────────────────────────────────────┘
```

> **Defer-honest:** the Credit Ledger, Invoices/Subscription, and Allocation panels render as
> `EmptyState` with honest gating copy until `[M11-ledger]`/`[Stripe]`/`[M12-lease]` clear. The
> shipped Actions + Purchases panels are the only live write surfaces (`02 §3.4`).

---

## Permission-aware rendering

| Control | UI gate (`canMaybe`) | API gate | JIT elevation |
|---|---|---|---|
| Adjust credits | `tenants:credits` | `requireCapability` + 403 elevation_required | mints `credit.adjust` |
| Apply plan | `tenants:plan` | `requireCapability` | — |
| Suspend | `tenants:credits` | `requireCapability` | mints `tenant.suspend` |
| Refund | `tenants:credits` | `requireCapability` | — |
| Ledger / Invoices read | `billing:read` | `requireCapability` | — |

All writes run through `withPlatformTx` with a mandatory `reason`; a no-op write rolls the audit row
back (`02 §3.2.4`).

## WCAG 2.2 AA / Responsive

- `StatusBadge` (active/suspended; purchase status) carries text, not color-only. `Progress`
  allocation bars have `aria-valuenow`/text label. Reason field required + labeled; destructive
  actions (Suspend, Refund) confirm. Focus-visible everywhere.
- ≥1024px: tiles in a row, tables full-width. <768: tiles stack; actions become a vertical list;
  tables → card rows.
