# List Tab — Admin & Staff Governance (07)

> **Status:** Plan (not yet built). **Owner:** Security + Platform. **Last updated:** 2026-06-24.
> This is the **primary realization of Decision D2** (`00-overview.md §3`): *staff powers are
> privacy-first*. It answers one question precisely — **what platform admins / application staff can
> and cannot do with customer-UPLOADED list data**. It cites the Locked Decisions (D1–D5) and
> Vocabulary in `00-overview.md`, the phase contract in `09-rollout-phases.md` (this work is **Phase 5**),
> and the governance research in `01-research-summary.md §F` (break-glass, least-privilege, immutable
> audit, customer-visible access logs). For the RLS/encryption/DSAR mechanics it leans on
> `08-security-compliance.md`; for the data model and ownership semantics, `02-data-model.md`.
>
> **Precedence (root `CLAUDE.md`):** Security has the final say on whether something is safe; Platform
> owns the RLS mechanism (D4). Every **CAN** below is defensible; every **CANNOT** is enforced at the
> **database (RLS)**, not merely hidden in the UI.

---

## 1. The principle (D2): customer list data is a trust asset, not a product asset

A customer's uploaded list — the CSV/XLSX they brought, the contacts they revealed and collected, the
PII they paid to enrich — **belongs to them**. Per **D1** it is *strictly isolated*: we **match-against**
the master graph for that customer's own dedup/enrichment, but **never contribute-to** the shared graph.
It is therefore **not raw material for the product**. Staff hold it in trust; they do not mine it.

The operating stance, the same one enterprise data products commit to (`01 §F` — least-privilege,
break-glass, immutable audit, customer-visible access):

- **Default = NO record-level access.** No member PII is visible to any staff tier in the normal
  console. This is the baseline, not an opt-in setting.
- **Record-level access is an exception, not a capability.** The *only* path into a tenant's list
  **contents** is a time-boxed, reason-gated, customer-visible **break-glass impersonation** (§4).
- **Everything staff do with list data is audited and append-only.** Every privileged access or action
  writes a `platform_audit_log` row in the same transaction (`withPlatformTx`, `client.ts`), and a
  trail that cannot be edited or erased (`rls/platform.sql` append-only trigger).
- **The customer can see staff looking.** A **customer-visible access log** (§5) surfaces staff
  accesses to the tenant — trust is verifiable, not promised.
- **Aggregate, never row-level, for the product side.** Usage/billing/health analytics over uploaded
  data are computed as **counts and rates**, never by reading PII (§7).

> This stance is *stronger* than "staff are trusted employees". The control is technical (RLS deny-all +
> append-only audit), so it holds even against an over-curious or compromised staff account. UI hiding
> is never the boundary (D4).

---

## 2. The three role tiers (recap) and which tier sees what

TruePoint already ships a **three-tier role model** (admin-auth buildout plan; `schema/auth.ts`,
`rls/platform.sql`). The tiers are deliberately **separate** — never merged into one enum.

| Tier | Where it lives | Roles | Gate |
|---|---|---|---|
| **Platform / staff** (cross-tenant) | `platform_staff` table | `super_admin`, `support`, `billing_ops`, `compliance_officer`, `read_only` | `requireStaffRole()` (after the coarse `pa` gate) |
| **Tenant / org** (within a customer org) | `tenant_members.org_role` | `owner`, `billing_admin`, `security_admin`, `compliance_admin`, `member` | `requireOrgRole()` |
| **Workspace** | `workspace_members.role` | `owner`, `admin`, `member`, `viewer` | `requireWorkspaceRole()` |

This doc governs **the platform/staff tier** — internal/application staff acting *across* tenants. The
org and workspace tiers are **customers operating their own data** inside their own RLS boundary
(D4); a workspace `member` reading their own list members is normal product use, not staff access, and
is **out of scope** here. (Customer-side list visibility — owner-scope vs. workspace, the soft-owner
model — lives in `02-data-model.md` and `04-list-workspace-ui.md`.)

**What each staff role sees of uploaded list data** (default, no impersonation):

| Staff role | List metadata | Aggregate usage/billing | System health / flags / provider cfg | Quarantine / DNC | Record-level list contents (PII) | Break-glass (impersonation) |
|---|---|---|---|---|---|---|
| `super_admin` | ✅ | ✅ | ✅ (manage) | ✅ | ❌ default | ✅ may start (super_admin/support) |
| `support` | ✅ | ✅ (read) | read | ✅ act on abuse | ❌ default | ✅ may start |
| `billing_ops` | ✅ (counts only) | ✅ (read) | ❌ | ❌ | ❌ | ❌ cannot impersonate |
| `compliance_officer` | ✅ | ✅ (read) | ❌ | ✅ DSAR/suppression | ❌ default | ❌ — reviews the audit log, does not enter content |
| `read_only` | ✅ (read) | ✅ (read) | read | ❌ | ❌ | ❌ |

Enforced by `requireStaffRole(...)` per route (function-level authz) **plus** RLS at the row level
(object-level authz) — defence-in-depth. The role is resolved **per-request from the DB**, so a revoke
takes effect on the next request with no stale-JWT window (`staff.ts`).

---

## 3. CAN / CANNOT capability matrix (uploaded list data)

This is the contract. Every **CAN** has a justification a regulator or customer would accept; every
**CANNOT** names the **RLS mechanism** that enforces it — not a UI rule.

### 3.1 CAN (the legitimate operating surface)

| Capability | Who | How it is read | Why it is safe |
|---|---|---|---|
| See list **metadata** — name, description, member **count**, owner, created/updated, `source` provenance, `list_kind` | all staff tiers | bounded cross-tenant read via `withPlatformTx` (audited, `PLATFORM_READ_LIMIT`) | metadata is **not member PII**; counts/names/timestamps describe the container, not its contents |
| **Aggregate** usage / credit / enrichment metrics — reveals spent, match-rate, bounce-rate, enrichment job tallies, import row counts | `super_admin`, `support`, `billing_ops`, `compliance_officer`, `read_only` | aggregate queries (COUNT/SUM/rate) via `withPlatformTx`; never SELECT of PII columns | §7 — derived from counts, no row-level PII leaves the boundary |
| **System health** — job-queue depth, DLQ, service status | `super_admin`, `support`, `read_only` | `admin.system_health` (existing `routes.ts`) | operational signal, no customer data |
| **Feature flags** (global + per-tenant) for `lists.*` rollout | `super_admin` (write), others read | existing flags surface (`routes.ts`, `featureFlags.sql`) | controls exposure, touches no list contents |
| **Provider configs** — enrichment provider enable/disable + budgets | `super_admin` | `provider-configs` routes | config, not customer data |
| **Quarantine / suppress a list** on confirmed abuse | `super_admin`, `support` | new `admin.list.quarantine` action, audited (§6) | abuse response acts on the **container's status**, not by reading members |
| **Act on a DSAR** touching list members (access/erase/rectify) | `compliance_officer` (+ `super_admin`) | the **privileged DSAR fan-out** (`withPrivilegedTx` / `leadwolf_admin`), audited; tombstone + `global` suppression on erase | a legally-mandated, separately-audited path (`08 §4`); not casual access |
| **Manage DNC / suppression** rows that gate reveal + bulk ops | `compliance_officer`, `support` | `suppression_list` writes (`scope ∈ {global,tenant,workspace}`), audited (`suppression.add/remove`) | protects data subjects; writes suppression keys (blind-indexed), does not read list PII |

### 3.2 CANNOT (the hard limits) — and what enforces each

| Capability staff **must not** have | Enforced by (RLS / mechanism, D4) |
|---|---|
| **Browse member PII at will** (open a list and read names/emails/phones) | `lists` + `list_members` are `ENABLE`+**`FORCE`** RLS, workspace-isolated on `app.current_workspace_id` (`rls/lists.sql`). Staff routes run `withPlatformTx` (owner connection, **no workspace GUC set**) → the workspace predicate matches nothing for member-PII reads. Member PII is reachable only via impersonation (§4), which sets the GUC under `leadwolf_app`. |
| **Bulk-export a tenant's list / PII** | No platform route exposes a member-PII export; the only export is the **customer's own** role-gated `export` action inside their workspace tx. A staff "export" would require impersonation (read-only-first, §4) and is itself audited + bounded. |
| **Train models / build product features on customer list data** | **D1**: contribute-to is OFF. Uploaded data never feeds the shared graph; no pipeline reads tenant `list_members` into a global store. Enforced by isolation (§ `02`/`06`) + the absence of any such job; an attempt would cross the workspace RLS boundary. |
| **Cross tenants** in a single read | `withPlatformTx` reads are **bounded** (`PLATFORM_READ_LIMIT`) and **shaped** (metadata/aggregate only); member-PII tables stay behind FORCE-RLS. No "all members across tenants" query exists or is reachable. |
| **Silently modify customer lists** (rename, add/remove members, change ownership) | Mutations on `lists`/`list_members` require the workspace GUC (`WITH CHECK` on `app.current_workspace_id`) → only a customer in-workspace tx, or an impersonation session, can write — and impersonation is reason-gated, time-boxed, and customer-visible. |
| **Read the platform audit trail to cover tracks** | `platform_audit_log` is **append-only** (trigger raises on UPDATE/DELETE for *every* role incl. owner) and **deny-all** to `leadwolf_app` (`rls/platform.sql`). Reading it is itself restricted (`super_admin`/`compliance_officer`) and audited. |

> **The single narrow exception** to "CANNOT read member PII" is the break-glass path in §4. There is
> no other. Everything in §3.1 is built so that day-to-day support *never needs* record-level access.

---

## 4. Break-glass record-level access (the only path to list contents)

When support genuinely must see a tenant's actual list members — to reproduce a bug the customer can't
describe, to validate a corrupted import, to action a verified DSAR by hand — the path is a **time-boxed,
reason-gated, customer-visible impersonation session**, built on the existing `impersonationSessions`
table (`schema/platformOps.ts`) + `withPlatformTx` audit (`impersonation.ts`). This is the textbook
break-glass control from `01 §F`: rare, justified, bounded, observed.

**Properties (already enforced today):**
- **Role-gated:** only `super_admin` or `support` may start one (`requireStaffRole("super_admin","support")`);
  `billing_ops`/`compliance_officer`/`read_only` cannot enter a tenant's context (`impersonation.ts`).
- **Reason mandatory:** a consent/justification `reason` (min 5 chars) is required and recorded on the
  session row + the audit row (`impersonationStartSchema`).
- **Time-boxed:** `expires_at` (default 30 min in the repo) hard-bounds the window; the session carries
  **no token/secret material** — it is the record of consent, not a credential.
- **Audited start + end:** both write `platform_audit_log` via `withPlatformTx`
  (`admin.impersonate.start` / `.end`), naming the target tenant/workspace/user + reason.

**Lifecycle (request → approve → time-box → auto-expire → post-review):**

1. **Request** — staff opens a session against a specific `target_tenant_id` (optionally narrowed to a
   `target_workspace_id` / `target_user_id`) with a written `reason`. Audited at `start`.
2. **Approve** *(to build, §8)* — for list **contents** access, require a second-person approval
   (super_admin) before the session grants record-level read; today the session is created directly.
   This is the four-eyes upgrade the governance research calls for (`01 §F`).
3. **Scope = read-only-first.** The session's minted token (the WIRE-deferred "login-as" token, see
   `impersonation.ts`) must default to **read-only** access to list contents. Any **write** to a
   tenant's list (member add/remove, rename, bulk action) requires an explicit, separately-audited
   step-up — never an implicit consequence of "being in" the tenant.
4. **Time-box / auto-expire.** Access ends at `expires_at` with no action; an early `DELETE
   /impersonation/:id` ends it sooner (audited `.end`). The active-session list (`GET
   /impersonation/active`) is the banner's source of truth.
5. **Post-review.** Because every action under the session writes `platform_audit_log` (§5), a
   compliance reviewer can later answer *who entered which tenant's lists, why, when, and what they
   touched* from the immutable trail.

**What to extend for list ops (§8 — Phase 5):**
- The minted impersonation token must carry the **session id**, so every list read/write performed
  under it is **attributable to the break-glass session**, not just to the staff user.
- Define **list-aware audit actions** emitted *inside* an impersonation session so the trail
  distinguishes "viewed list metadata" (no session needed) from "viewed list members"
  (`admin.list.view_members`) and "ran a bulk action as the tenant" (`admin.list.bulk_action`).
- Enforce **read-only-first**: list-content **writes** under impersonation require the step-up + their
  own audit action.

---

## 5. Audit & customer visibility

**Every staff access to (or action on) a tenant's list data emits an append-only
`platform_audit_log` row** — written in the *same transaction* as the action (`withPlatformTx`,
`client.ts`), so a failed/rolled-back action leaves no trace and a successful one always does. The row:

```
{ actor_user_id, action, target_type='list', target_id=<list id>,
  tenant_id, workspace_id, ip, metadata (incl. impersonation session id + reason), occurred_at }
```

The trail is **immutable**: `UPDATE`/`DELETE` raise for every role via the append-only trigger, and the
table is **deny-all to the customer app role** (`rls/platform.sql`). Reading it is restricted to
`super_admin`/`compliance_officer` and is *itself* audited (`admin.read_audit_log`, `auditLog.ts`).

**List-aware platform-audit action vocabulary (to add — Phase 5):** `platform_audit_log.action` is
free-text today, so these need no migration, only a defined, code-referenced vocabulary:
`admin.list.view_metadata`, `admin.list.view_members` (impersonation-only),
`admin.list.bulk_action` (impersonation-only), `admin.list.quarantine`, `admin.list.unquarantine`,
`admin.list.dsar_action`.

**Customer-visible access log (to build — Phase 5).** Trust is verifiable only if the customer can see
staff looking. Surface staff *record-level* accesses to the tenant on a customer-facing
**Access Log** (in workspace/tenant settings). Two implementation options, both honoring D4:
- **Preferred:** when a break-glass session touches list contents, mirror a **customer-visible**
  `audit_log` row (the existing append-only customer log, `billing.ts`) with a new
  `staff.access` action (entity_type=`list`), so it appears in the tenant's own activity feed and
  compliance viewer under their RLS. The customer sees actor=TruePoint Support, the list, the reason,
  and the time.
- The platform-side `platform_audit_log` remains the authoritative internal record; the customer-side
  row is the **transparency surface** derived from it.

> **DSAR note.** A data subject must be able to learn that their record was accessed; the customer-visible
> access log + the immutable `platform_audit_log` together satisfy the "who accessed my data" obligation
> (`08 §4`).

---

## 6. Abuse / fraud / DNC

Operating uploaded data safely means catching misuse **without reading the data**.

**Scraping / abuse detection on aggregate signals (no PII).** Detection runs on **rates and counts** —
reveal velocity, import volume spikes, match-rate anomalies, credit-burn patterns, repeated
suppression hits — read via `withPlatformTx` aggregates (§7), never by inspecting member rows. A signal
flags a **list or workspace**, not a person.

**List quarantine.** On confirmed abuse, `super_admin`/`support` can **quarantine** a list: a status
flag on the `lists` container (Phase 0 adds list lifecycle columns per `09 §Phase 0`; quarantine reuses
that) that **disables bulk ops / reveal / export** for that list while leaving the data intact and the
customer notified. Quarantine acts on the **container**, so it needs no record-level read; it is audited
(`admin.list.quarantine`) and surfaced to the customer (§5). Lifting it (`admin.list.unquarantine`) is
likewise audited.

**DNC / suppression management feeding reveal + bulk ops.** The `suppression_list` table already gates
**reveal and send** in-transaction via the unbypassable `assertNotSuppressed` gate
(`core/compliance/assertNotSuppressed.ts`), with `scope ∈ {global, tenant, workspace}` and
`match_type ∈ {email, domain, phone, contact_id}` (blind-indexed keys, never plaintext). Governance
work (Phase 5) **extends suppression gating to list bulk operations** — a `work-the-list` enrich /
verify / reveal / export must consult the same gate, so a DNC/suppressed contact is never actioned in
bulk. Compliance/support manage these rows (`suppression.add/remove`, audited in the customer log).
A person-level **erasure** writes a **`global` suppression row** to prevent re-import of an erased
subject (`09 §Phase 5`, ADR-0021 cascade).

---

## 7. Usage / billing analytics (aggregate-only)

Staff and the billing surface need to answer "how much is this tenant using lists, and what should they
be charged" — **without** reading a single member's PII.

- **Aggregate-only metrics:** list **counts**, member **counts**, import **row counts**, reveals spent,
  enrichment **match-rate** and **bounce-rate**, credit consumption, enrichment-job tallies by status.
  All are `COUNT`/`SUM`/ratio queries via `withPlatformTx` (bounded, audited); **no query selects a PII
  column** (name, email, phone, encrypted bytea).
- **Never row-level:** there is no staff/billing path that returns member rows. `billing_ops` sees the
  numbers that drive invoices (seats, credits, plan, usage), not the contacts behind them. This mirrors
  the existing tenants-directory read (`admin.list_tenants` / `admin.get_tenant`, `routes.ts`), which
  already returns plan/status/seats/credits and **not** member data.
- **Money rules are inherited (D5):** charge only for matched/valid data; credit-back on hard bounce
  (ADR-0007/0013). Those run inside the customer's tx, not staff analytics — staff only *report* the
  aggregates.

---

## 8. Gaps vs. today + what to build (Phase 5)

The foundation exists (3-tier RBAC, append-only `platform_audit_log`, `impersonationSessions`,
`withPlatformTx`, `suppression_list`, FORCE-RLS on `lists`/`list_members`). The **list-specific
governance layer** is the Phase 5 build (`09 §Phase 5`; work units 12–13).

| # | Gap today | What to build | Where |
|---|---|---|---|
| 1 | **No list-aware platform-audit actions** — `platform_audit_log.action` has no list vocabulary | Define + emit `admin.list.view_metadata` / `view_members` / `bulk_action` / `quarantine` / `unquarantine` / `dsar_action`; member-PII actions only emit *inside* an impersonation session | `apps/api/.../admin` + `withPlatformTx` callers |
| 2 | **No customer-visible access log** — the customer cannot see staff record-level access | Add a `staff.access` action to the customer `audit_log` action enum (migration) + mirror a customer-visible row when break-glass touches list contents; surface it in tenant/workspace settings | `db` migration (`billing.ts` enum) + `apps/web` settings + `admin/web` |
| 3 | **Impersonation token is WIRE-deferred + not list-aware** | Mint the scoped, time-boxed "login-as" token carrying the **session id**; default **read-only** to list contents; require step-up + audit for any list **write** under impersonation; add the **four-eyes approval** for content access | `packages/auth` + `apps/api/.../impersonation.ts` |
| 4 | **No quarantine / DNC management UI** | Build the staff **quarantine-a-list** action (status flag, audited, customer-notified) and the **DNC/suppression** management surface that feeds reveal **and** list bulk ops | `apps/api` (quarantine + suppression routes) + `apps/admin/web` |
| 5 | **Suppression gating not yet on list bulk ops** | Extend `assertNotSuppressed` to the `work-the-list` bulk enrich/verify/reveal/export path so DNC/suppressed contacts are never actioned in bulk | `packages/core/prospect/bulkActions.ts` + list bulk routes (`06`/`03`) |
| 6 | **Staff capability enforcement is route-level only for new list ops** | Apply `requireStaffRole(...)` to every new list-governance route + the **isolation/staff-no-access itest** that proves no staff path returns member PII without impersonation, and that impersonation is required + audited for content | `apps/api` middleware + `packages/db/test` |
| 7 | **DSAR cascade over lists unproven for the list path** | The DSAR fan-out must cascade `list_members` on erase, tombstone the contact across copies, and write a `global` suppression row to block re-import — with an itest proving it (`09 §Phase 5`) | `packages/core/compliance/deleteFanout.ts` + `packages/db/test` |

**Done when (mirrors `09 §Phase 5`):** the **staff-no-access itest** is green (no impersonation ⇒ zero
member rows for any staff path); record-level access is **required to go through impersonation** and is
**audited**; the **customer-visible access log** shows staff accesses; **quarantine + DNC** gate list
bulk ops; and the **DSAR cascade** over lists is proven.

---

## 9. Cross-references

- **`00-overview.md`** — D1 (isolation), **D2 (privacy-first staff — this doc realizes it)**, D4 (RLS
  is the boundary), D5 (money rules), and the shared vocabulary (break-glass, match-against).
- **`01-research-summary.md §F`** — governance research: least-privilege, break-glass, immutable audit,
  customer-visible access logs (the sources behind §1/§4/§5).
- **`02-data-model.md`** — list schema, customer-side ownership (owner-scope vs. workspace), DSAR cascade.
- **`06-enrichment-verification.md`** — bulk ops + suppression gating extension referenced in §6.
- **`08-security-compliance.md`** — the RLS/encryption/GDPR-CCPA/DSAR/retention mechanics this doc relies
  on; §3's "enforced by RLS" claims trace to the policies catalogued there.
- **`09-rollout-phases.md` (Phase 5, work units 12–13)** — the execution contract for this build.
