# Platform Admin — Implementation Status & Deferred Register (P7 closeout)

> Companion to `00-README.md` (the roadmap) and `15-foundations-and-security.md` (the security specs). This
> doc records what the **"build safe gaps, flag rest"** program actually SHIPPED to `main`, the final-QA
> attestation, and the implementation-ready register of what remains DEFERRED — each because it needs a
> **human security/product decision** or **infrastructure this build host cannot verify** (no docker/Redis
> for migration-apply + RLS-isolation + queue itests). Nothing was built blind.

## 1. Shipped (on `main`)

| Phase / area | What shipped | Notable commits |
|---|---|---|
| **P1 — UX & correctness** | `canMaybe(...)` render-gates on every write surface; new `flags:manage` capability; async entity pickers (Entity/Tenant/User) replacing raw-UUID entry; `Idempotency-Key` on credit grants; two pre-existing prod-build typecheck errors cleared | `d683a08`, `2f747db` |
| **P2 — Billing depth** | per-tenant economics drill-down (3-CTE cross-tenant read), audited formula-injection-safe CSV export, low-balance / churn-risk list | (billing slice) |
| **P3 — Compliance** | DSAR queue made actionable (verify / process / reject) with a server-side state machine + a "no manual `completed`" guard; **sub-processor registry** (GDPR Art. 28) — table `sub_processors` (migration 0035) + audited CRUD + Compliance-page section | `ae4912f`, `1bb1450` |
| Directory filters | Users + Tenants status filters (server-pushed) | (filters slice) |
| **P4 — Observability** | **maintenance-mode** — an `announcements.type` (general\|maintenance) column (migration 0036) reusing the whole announcements pipeline; admin Type selector pins site-wide critical; apps/web renders maintenance NON-DISMISSIBLE. System-health depth — surfaced the live BullMQ per-queue probe (depth/DLQ/workers/saturation) + a success-rate tile | `e3a3436`, `112f588`, `63d8eeb` |
| **P5 — Data-quality cockpit** | cross-tenant DQ read (latest snapshot per workspace + the re-verification ledger) + a new read-only `data-quality` tab (coverage/validity/freshness rates) | `c91ba17`, `27cce96` |
| **P6 — Trust / abuse** | cross-tenant trust signals (signup velocity, free/disposable-email heuristic, active holds by kind, tenant-status mix) + a new read-only `trust-abuse` tab | `05b5a69`, `1c23f53` |
| **Full re-audit** | a 28-agent adversarial re-audit of all 14 tabs; every confirmed High + worthwhile Medium/Low finding fixed (busy-state races, loadMore data-loss, confirmation dialogs, empty-states, input bounds, label mismatches, feature-flag key validation) | `546a192`, `447cf38`, `84de398`, `fcae56e`, `150de9f` |

Every slice was gated locally (`turbo typecheck` + `biome`, and the `platformAuditCoverage` drift guard
where a new audited action was added) before push. Migrations are **hand-authored** (never `drizzle-kit
generate` — the meta snapshots are stale vs the 0029+ chain) and CI-verifies their application + RLS-deny
isolation.

## 2. Final QA (2026-06-30)

- `bun run typecheck` — **13 / 13 packages green**.
- `bun test packages/types` — **74 pass / 0 fail**, including the `platformAuditCoverage` drift guard
  (every `platformAuditAction` value is attested WRITTEN or PENDING; the new `sub_processor.set` is WRITTEN).
- No new audited action was left unattested; no new platform table was left without an RLS deny-all + REVOKE.

## 3. Deferred — SECURITY (needs a human decision; the spec is implementation-ready)

These are **not** half-built. Each has a concrete spec in `15-foundations-and-security.md`; building it
requires a security/product decision that is the owner's to make, and verification (auth-boundary or
RLS-isolation) that this host cannot perform.

| Item | Spec | Why deferred (not built blind) | Decision the owner must make |
|---|---|---|---|
| **F6 — impersonation token mint** | §5.1, §10 (G1) | mints a real "login-as" access token — an auth-boundary change; the session record exists but the scoped token does not | read-only-vs-full scope, `exp`/session-binding, revocation deny-list (Redis) |
| **F2 — staff SSO / mandatory MFA / IP-allowlist enforcement** | §5.3, §10 (G3), §17 (Phase 3) | IP is captured in audit but never enforced; SSO/MFA needs an external IdP; an allowlist carries lockout risk | IdP (Okta/Azure-AD), MFA mandate, allowlist source + break-glass path |
| **JIT peer-approval** | §5.2, §7.1 | a `pending`→`approved` lifecycle on `jit_elevations` (the `approved_by_user_id` seam exists, no migration needed) — but it changes the elevation **consume** path that gates credit/suspend, and verifying it needs the RLS-isolation itest (CI/docker) | enable peer-approval? + the approver model (who may approve) |

## 4. Deferred — INFRASTRUCTURE / verification (per the P4 scoping workflow)

- **DLQ retry-from-dead-letter** — a BullMQ job mutation; needs Redis + queue-semantics verification (no local docker).
- **Live ECS / DB / search probes** — no api client exists to probe those services; system-health honestly reports `unknown` rather than fabricating a green check.
- **apps/web read-only WRITE-ENFORCEMENT** — a cross-app middleware change (the maintenance banner is shipped; blocking writes during maintenance is the deferred half).
- **New-table features** (legal-holds, data-residency controls, AI/automation ledgers) — buildable via the **proven hand-authored-migration recipe** (see `sub_processors` 0035) when prioritized; deferred only by priority, not by capability.

## 5. How to resume a deferred item

1. Make the decision in §3 (security) — this is the gate.
2. Implement per the item's `15-foundations-and-security.md` section. **Hand-author** any migration (idempotent
   `.sql` + a `_journal.json` entry — never `drizzle-kit generate`); add the RLS deny-all + the
   `applyMigrations` REVOKE for any new table; add any new audited action to the `platformAuditAction` enum +
   the coverage drift guard.
3. Gate locally (typecheck + biome + the drift guard) and let **CI verify** migration apply + RLS isolation +
   queue behaviour (the host-level gaps).
