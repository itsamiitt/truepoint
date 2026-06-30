# Wireframe — admin `/plans` (Plan templates catalog)

> Portal: `apps/admin` · Owned by `04_Admin_Experience.md` · IA placement: `03 §6.1`.
> Primitives (existing only): `DataTable`, `StatusBadge`, `StateSwitch`, `EmptyState`, `Skeleton`.
> Capability: **`pricing:manage`** (write). Reuses plans tab audit `04-plans.md` gap IDs.

---

## State: LOADING

```
┌──────────────────────────────────────────────────────────────┐
│ Plans                                       [+ New plan]     │
│ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒  ← Skeleton rows                    │
└──────────────────────────────────────────────────────────────┘
```

## State: EMPTY

```
│ (EmptyState) No plan templates yet.        [+ New plan]      │  ← CTA gated pricing:manage
```

## State: ERROR

```
│ ⚠ Couldn't load plans — {title}/{detail}        [ Retry ]   │
```

## State: DATA

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Plans (plan_templates catalog — [exists] 02 §3.4)         [+ New plan]    │  ← gate pricing:manage
├──────────────────────────────────────────────────────────────────────────┤
│  Key        Name       Seats  Workspaces  Monthly grant  Active   Actions │
│  ──────────────────────────────────────────────────────────────────────  │
│  free       Free          1        1          — (dormant)  [On]  [Edit]   │
│  pro        Pro           5       3           5,000*       [On]  [Edit]   │
│  enterprise Enterprise   ∞ (null)  ∞ (null)   50,000*      [Off] [Edit]   │
│   * monthly_credit_grant column EXISTS but NO JOB consumes it (02 §3.1.8) │
├──────────────────────────────────────────────────────────────────────────┤
│  EDIT PANEL (per template)                                                │
│   Seats [__]  Workspaces [__ (blank=∞)]  Features {jsonb flags…}          │
│   Active [On/Off]                                                         │
│   ── Recurring / subscription config  [decision-gated — proposed ADR-0041]│
│      Term [month-to-month ▾]  Auto-renew [Off ← DEFAULT, LD-1]            │
│      (disabled until ADR-0041 approved; never defaulted-on)               │
│   ── Activate monthly_credit_grant  [decision-gated][M11-ledger]          │
│      (disabled until a monthly-grant job + ledger exist)                  │
│   Plan-change impact preview [exists-partial — 04-plans audit]           │
│      "N tenants on this plan; M would be grandfathered"                   │
│                                          [ Cancel ]  [ Save ]            │
└──────────────────────────────────────────────────────────────────────────┘
```

> **Defer-honest:** the recurring/subscription block and `monthly_credit_grant` activation are
> **disabled** with an honest note — they are proposed `ADR-0041` / `[M11-ledger]`, not built
> (`02 §3.1.8` confirms the column is dormant). Auto-renew is **Off by default** per LD-1.

---

## Permission-aware rendering

- `[+ New plan]`, `[Edit]`, `[Save]`, active toggle all gated by
  `useStaffMe().canMaybe("pricing:manage")`; API enforces (`02 §3.2.3`, audit `plan_template.set`).
- A staff member with read-only view (no `pricing:manage`) sees the table but no write controls.

## WCAG 2.2 AA / Responsive

- Active state shown as `StatusBadge` On/Off **with text**, not color-only. `null`=∞ rendered as the
  glyph **and** a "(unlimited)" tooltip/`aria-label`. Save/Cancel focus-visible; form labels bound.
- ≥1024px full table; <768 `DataTable` → card rows, edit panel becomes a full-screen sheet.
