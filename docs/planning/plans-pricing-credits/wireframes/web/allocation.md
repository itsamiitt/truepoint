# Wireframe — web Allocation (team/workspace budgets + per-user soft limits)

> Portal: `apps/web` · Owned by `05_Web_Experience.md` · IA placement: hub Credits → Allocation
> sub-surface (`03 §6.2`). Flow: `03 §7.4`. Primitives (existing only): `StatTile`, `DataTable`,
> `Progress`, `StatusBadge`, `StateSwitch`, `EmptyState`, `Skeleton`.
> Gating: **`[M12-lease]` `[decision-gated]` — proposed `ADR-0042`; NOT BUILT** (no budget tables,
> `02 §3.1`). ws-admin only (OD-8). **Tenant pool stays authoritative (LD-2).**

---

## State: EMPTY / not-built (today's reality)

```
(EmptyState) "Team & per-user credit allocation arrives with M12 leases
 (proposed ADR-0042). Today the whole tenant pool is shared — no per-team budgets exist."
```

## State: LOADING / ERROR

```
LOADING: [▒▒▒▒] pool tile + ▒▒▒▒ rows   ERROR: ⚠ {title}/{detail} [Retry]
```

## State: DATA (target render, when M12 lands)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Allocation                                             (ws-admin only OD-8)│
├──────────────────────────────────────────────────────────────────────────┤
│ ┌────────────────────────┐                                               │
│ │ Tenant pool (authoritative LD-2)                                       │
│ │ 100,000 credits · 62,000 allocated · 38,000 unallocated                │
│ │ [Progress ██████░░░░ 62% allocated]                                    │
│ └────────────────────────┘                                               │
├──────────────────────────────────────────────────────────────────────────┤
│ TEAM / WORKSPACE BUDGETS  (DataTable)  [M12-lease]                        │
│  Team        Budget     Used                          Edit                │
│  ───────────────────────────────────────────────────────────────────────│
│  Sales       40,000     [Progress ███████░░ 72%]      [ Set budget ]      │
│  Marketing   22,000     [Progress ████░░░░░ 40%]      [ Set budget ]      │
│   Invariant: SUM(team budgets) ≤ tenant pool (enforced server-side,       │
│   ADR-0029 leases — 03 §7.4). Over-allocation → 422.                     │
├──────────────────────────────────────────────────────────────────────────┤
│ PER-USER SOFT LIMITS  (DataTable)  [M12-lease]                            │
│  User         Soft limit   Used        Status                            │
│  ───────────────────────────────────────────────────────────────────────│
│  alice@…      2,000        1,840       [StatusBadge: near limit]          │
│  bob@…        1,000          120       [StatusBadge: ok]                  │
│   Soft limit = advisory (warns), NOT a hard block (03 §7.4).             │
└──────────────────────────────────────────────────────────────────────────┘
```

> **Defer-honest:** the entire surface is `EmptyState` today; the DATA render is the target once M12
> budgets + proposed `ADR-0042` land. Tenant pool remains the single source of truth (LD-2).

---

## Permission-aware rendering / WCAG 2.2 AA / Responsive

- Set-budget / set-limit gated by workspace-admin (OD-8); non-admins get read-only `Progress` bars.
  API enforces the SUM-≤-pool invariant (`03 §7.4`).
- `Progress` bars carry `aria-valuenow` + text %; `StatusBadge` ("near limit"/"ok") has text, not
  color-only. Set-budget inputs labeled, numeric.
- ≥1024px: pool tile + two tables. 768–1023: tables scroll-x. <768: tables → card rows; pool tile
  full-width on top.
