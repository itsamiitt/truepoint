# Wireframe — admin `/billing` (Billing & Revenue Ops)

> Portal: `apps/admin` · Owned by `04_Admin_Experience.md` · IA placement: `03 §6.1`.
> Primitives used (existing only): `StatTile`, `DataTable`, `StatusBadge`, `Progress`,
> `StateSwitch`, `EmptyState`, `Skeleton`. Capability: **`billing:read`** (read-only tab).
> Gating per section noted inline. Four states shown. WCAG 2.2 AA + responsive notes at foot.

---

## State: LOADING (`StateSwitch` → `Skeleton`)

```
┌──────────────────────────────────────────────────────────────────────┐
│ Billing & Revenue Ops                         [Period ▾ 30d]          │
├──────────────────────────────────────────────────────────────────────┤
│ [▒▒▒▒▒] [▒▒▒▒▒] [▒▒▒▒▒]   ← Skeleton StatTiles (no layout shift)      │
│ [▒▒▒▒▒] [▒▒▒▒▒] [▒▒▒▒▒]                                              │
│ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒  ← Skeleton DataTable rows                  │
└──────────────────────────────────────────────────────────────────────┘
```

## State: ERROR (`StateSwitch` error branch)

```
┌──────────────────────────────────────────────────────────────────────┐
│ Billing & Revenue Ops                         [Period ▾ 30d]          │
├──────────────────────────────────────────────────────────────────────┤
│  ⚠  Couldn't load economics                                          │
│      {RFC 9457 title} — {detail}                          [ Retry ]   │
└──────────────────────────────────────────────────────────────────────┘
```

## State: EMPTY (no data in window)

```
┌──────────────────────────────────────────────────────────────────────┐
│ Billing & Revenue Ops                         [Period ▾ 30d]          │
├──────────────────────────────────────────────────────────────────────┤
│            (EmptyState)  No billing activity in this period.          │
│                          Try a wider window.                          │
└──────────────────────────────────────────────────────────────────────┘
```

## State: DATA

```
┌──────────────────────────────────────────────────────────────────────┐
│ Billing & Revenue Ops                         [Period ▾ 30d]  [Export CSV]│  [exists]
├──────────────────────────────────────────────────────────────────────┤
│ ROLLUP  (StatTile grid — [exists] 02 §3.4)                            │
│ ┌──────────┐ ┌──────────┐ ┌──────────┐                               │
│ │ Revenue  │ │ Provider │ │ Gross    │                               │
│ │ $12,480  │ │ spend    │ │ margin   │                               │
│ │          │ │ $3,910   │ │ $8,570   │                               │
│ └──────────┘ └──────────┘ └──────────┘                               │
│ ┌──────────┐ ┌──────────┐ ┌──────────┐                               │
│ │ Cost /   │ │ Credits  │ │ Reveals  │                               │
│ │ reveal   │ │ sold     │ │ charged  │                               │
│ │ $0.043   │ │ 412,000  │ │ 90,210   │                               │
│ └──────────┘ └──────────┘ └──────────┘                               │
├──────────────────────────────────────────────────────────────────────┤
│ MRR / ARR / CHURN   [exists-partial — 03 §6.1; audit 03-billing G4]   │
│ ┌──────────┐ ┌──────────┐ ┌──────────┐                               │
│ │ MRR      │ │ ARR      │ │ Churn %  │   (disabled/"—" until built)   │
│ └──────────┘ └──────────┘ └──────────┘                               │
├──────────────────────────────────────────────────────────────────────┤
│ BY-TENANT ECONOMICS  (DataTable — [exists])                           │
│  Tenant            Revenue   Spend    Margin   Recon          Action  │
│  ─────────────────────────────────────────────────────────────────── │
│  Acme Corp         $4,210    $1,180   $3,030   [✓ reconciled] →detail │
│  Globex            $2,090    $  720   $1,370   [— M11-ledger] →detail │  ← StatusBadge
│  Initech           $1,940    $  610   $1,330   [— M11-ledger] →detail │
│   Recon column = [M11-ledger]: shows "—" until credit_ledger exists   │
├──────────────────────────────────────────────────────────────────────┤
│ LOW-BALANCE TENANTS  (DataTable ≤100 — [exists])                      │
│  Tenant            Balance    Threshold   Status                      │
│  Hooli                  12         20      [StatusBadge: low]          │
├──────────────────────────────────────────────────────────────────────┤
│ DUNNING / FAILED PAYMENTS  [Stripe][decision-gated — 03 §6.1]         │
│  (EmptyState) "Failed-payment recovery arrives with Stripe Billing."  │
├──────────────────────────────────────────────────────────────────────┤
│ INVOICES (cross-tenant)  [Stripe][flag]                               │
│  (EmptyState) "Invoices register arrives with billing."               │
└──────────────────────────────────────────────────────────────────────┘
```

> **Defer-honest:** the MRR/ARR/churn tiles, Recon column, Dunning, and Invoices sections render as
> "—"/`EmptyState` until their gating (`[exists-partial]`/`[M11-ledger]`/`[Stripe]`/`[flag]`) clears.
> Never a fabricated value.

---

## Permission-aware rendering

- Whole tab visible only if `useStaffMe().canMaybe("billing:read")`; API enforces `requireCapability`.
- **Export CSV** is `billing:read` (audited `admin.billing_economics_export`, formula-injection
  guarded — `02 §3.2.2`). No write controls live on this tab (`02 §3.4`).

## WCAG 2.2 AA

- Margin/low-balance never color-only: pair `StatusBadge` color with label text ("reconciled",
  "low"). Contrast ≥ 4.5:1 via `var(--tp-*)` tokens.
- `[Period ▾]` select keyboard-operable, focus-visible; `aria-live=polite` on tile values after a
  period change. `DataTable` headers have `scope`.

## Responsive

- ≥1024px: 3-col StatTile grid + full-width tables. 768–1023: 2-col tiles, tables scroll-x.
  <768: 1-col tiles stacked; `DataTable` collapses to card rows; period select stays pinned.
