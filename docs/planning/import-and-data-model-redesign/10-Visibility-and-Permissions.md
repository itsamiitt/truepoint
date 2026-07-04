# 10 — Job Visibility & Permissions

> **Status of this doc:** design complete 🔲 (nothing here is built; statuses per series legend).
> **What this doc owns:** the uniform job-visibility and permission model for **Surface 2**
> (customer `apps/web`/`apps/api`) — **G01** (P0: job lists are workspace-visible; the reported
> "queued import jobs are visible to every user" defect) and **G02** (P1: "import at all" is not
> a named grant), per [`02 §Register`](02-Root-Cause-and-Gap-Analysis.md#register). Applies
> **uniformly to ALL job surfaces** — import + reveal + enrichment lists + the home Recent
> Imports card — per confirmed program decision 3 (README §Confirmed program decisions).
> **What this doc does not do:** redesign record (contact/account) sharing (§6.3 scope wall),
> touch Surface-1 staff permissions (owned by
> [`database-management-research/11`](../database-management-research/11-Roles-and-Permissions.md)),
> or design the import endpoints themselves (doc [`08`](08-Import-Architecture.md) owns the verbs;
> this doc owns WHO may do/see WHAT on them).

---

## Objective

Fix the confirmed P0 defect class — every workspace member sees every other member's jobs — with
one policy, one enforcement mechanism, and one propagation matrix that covers every current and
future job surface, such that:

1. **Members see their own jobs; workspace admins/owners see all jobs with creator attribution**
   (the market-default split — 03 §5.1 [7][56]).
2. The predicate is **structurally unforgettable**: it lives inside repository method signatures
   (a required viewer-context parameter), so a future surface that omits it fails to compile
   rather than ships leaking (§4).
3. "Import at all" becomes a **named, role-anchored grant** with a per-workspace policy escape
   hatch — no new permission system (§3).
4. Tenancy is untouched: **RLS keeps guaranteeing TENANCY; the app layer adds OWNERSHIP** (§1).

---

## Reconciliation (what this design builds on and must never contradict)

Pinned to shipped code at the same head as doc 01 (branch `feat/data-mgmt-01-research-brief`):

- **The tenant wall stays exactly as shipped (DM4).** `withTenantTx` sets `SET LOCAL ROLE
  leadwolf_app` + the two GUCs `app.current_tenant_id` / `app.current_workspace_id`, LOCAL,
  fail-closed (`packages/db/src/client.ts:82–91`). **There is no user GUC** — confirmed at head —
  and this design adds none (§1). No RLS policy is created, altered, or dropped by any S-V step.
- **The role tier for job surfaces is the *workspace* role** — the shipped closed enum
  `owner | admin | member | viewer` (`packages/types/src/auth.ts:16`), resolved per request from
  the active workspace membership by `requireRole` and stashed for handlers via
  `getWorkspaceRole` (`apps/api/src/middleware/requireRole.ts:14–32`). Terminology pin: where the
  program brief says "org-role override," the shipped tier that carries it is this workspace
  role. The separate tenant-level `orgRole` enum (`owner | billing_admin | security_admin |
  compliance_admin | member`, `auth.ts:23–30`, enforced by `requireOrgRole.ts:14–28`) governs
  org-administration domains (billing/SSO/compliance), **not** workspace job objects; the
  db-mgmt-research 11 §5.4 boundary statement ("self-service = own-workspace only, gated by role
  + owner filter + RLS via `withTenantTx`") is honored with the workspace tier as the precise
  instrument — job tables are workspace-scoped rows, and the live job lists already gate on
  `requireRole` (`reveal/routes.ts:201`, `enrichment/routes.ts:47`).
- **Two-surface wall (README §Two-surface note).** Staff capabilities
  (`packages/types/src/staffCapability.ts:13–38`, 21 caps; `data:*` at :33–37) never gate
  `apps/web`; a workspace/org role never gates `/admin/*`. Nothing in this doc uses a staff cap.
- **The creator columns already exist and are populated** — `import_jobs.created_by_user_id`
  (`schema/importJobs.ts:45`), `reveal_jobs.created_by_user_id` (`schema/revealJobs.ts:39`),
  `enrichment_jobs.created_by_user_id` (`schema/enrichmentJobs.ts:47`), and
  `source_imports.imported_by_user_id` (01 §4.4) — all with the `null = system/automation`
  convention. This design reads them; it does not add creator columns.
- **Ownership-as-filter is the shipped house pattern.** `contacts.owner_user_id` is deliberately
  filter-only atop workspace RLS (01 §6.4), and id-scoping guards like
  `contactRepository.visibleContactIds` (`contactRepository.ts:767`) show the app-layer-predicate
  idiom this doc generalizes to job objects. The truepoint-data mandate this doc implements:
  *"Visibility defaults to the owner; sharing is explicit … The hard boundary is RLS at the
  workspace; ownership is a filter dimension layered on top"* (truepoint-data SKILL §Core
  Principles).
- **Doc 08 dependency contract.** 08's S-I4 ships the tenant list/detail/cancel routes and
  states: *"the list ships only with 10's predicate"*; 08 §2.2 defers the cancel actor matrix
  here; 08 §5 defers the strategy-default setting's *permission* here. This doc supplies all
  three. The per-workspace policy row (§3) mirrors the shipped one-row-per-workspace
  `enrichment_policy` idiom (`schema/enrichmentPolicy.ts:24–43`).
- **Prior-series consistency:** DM1–DM9 untouched (DM4 explicitly relied on);
  `data-management/15` (bulk import design-of-record) is orthogonal — it never specified list
  visibility; no fixed migration numbers (step IDs S-V1…S-V6, sequenced by doc 15).

---

## Current Challenges (headline only — the as-is inventory is 01 §5)

Every job-visibility surface in the customer app is the tenant wall and nothing else: RLS
`workspace_id` isolation + `requireRole(...,"viewer")` at most, creator columns unread (01 §5.7
matrix). A viewer sees every member's reveal jobs (`reveal/routes.ts:201–208`) and enrichment
jobs (`enrichment/routes.ts:47–56`); every member's home page shows every member's uploads
(01 §4.4); the dead `importJobRepository.listJobsByWorkspace` would leak identically the moment
it was routed (`importJobRepository.ts:170–177`). Meanwhile **no import verb has any role gate at
all** — `POST /imports`, `POST /preview`, `GET /:jobId` carry no `requireRole`
(`import/routes.ts:115,127,168`), and mapping templates are creatable/deletable by anyone in the
workspace (`import-mapping-templates/routes.ts:47–86`). RLS cannot carry the fix: there is no
user GUC, so "owner or admin" is inexpressible in policy today (01 §5.1) — which is the design
opportunity, not a blocker (§1).

---

## Enterprise Best Practices (cited via 03's register only)

- **The chosen default is the documented market contract:** HubSpot's export-log rule — members
  see their own, super-admins see all (03 §5.1 [7]) — and Salesforce's abort rule — cancel if
  you created it **or** hold the named 'Manage Data Integrations' permission (03 §5.1 [56][76]).
- **Attribution on shared lists:** HubSpot's past-imports table renders "Created by" per row
  (03 §5.1 [6]); Salesforce's monitor is org-wide *with* creator context (03 §5.1 [54][55]).
- **Metadata ≠ artifacts:** downloading the original import file is gated to "the user who
  completed the import or Super Admin" even where the history row is broadly visible; error-file
  access is a per-import action; super-admins can track who downloaded a file, incl. IP and date
  (03 §5.1 [6][7]). The split see-the-row / cancel / download-artifact, loosest→tightest, is
  03 §5.2's direct implication.
- **"Import at all" is a named per-user grant everywhere surveyed** — HubSpot's "Import" toggle,
  Outreach governance "CSV Import", Apollo per-profile CSV import — never implicit from
  membership (03 §5.1 [17][117][79][80][84]).
- **No platform ships a per-job "share with team" toggle** — job visibility derives from
  role/permission only (03 §5.1 [16][52][53][117]) — so deferring our share-flag UX needs no
  apology (§2.3). Approval ladders (HubSpot export ladder, 03 §5.1 [17]) = doc 14 future.
- Where a product UI lacks attribution, the audit log is the documented fallback (03 §5.1 [27])
  — our download/action audit (§7) is that surface from day one.

---

## Gaps (register pointers — evidence in 01, linkage in 02)

**Owned here:** **G01** (P0 — the reported defect; RC-1) · **G02** (P1 — no named import grant;
RC-1). **Consumed from 08:** G04 (the list endpoint this predicate rides), G05 (cancel — actor
matrix here), G14 (error artifacts — access gate + download audit here; content/redaction in
13). **Interacts:** G26 ◇ (staff drill-down stays Surface-1, §6.1).

---

## Recommended Solution

### §1 The decision — app-layer owner predicate + workspace-role override; NO user GUC 🔲

**Restated (program spine):** job visibility = an application-layer predicate over
`created_by_user_id`, overridden by elevated workspace role (`admin`/`owner`), enforced inside
repository signatures. RLS continues to guarantee **tenancy** (the workspace wall, DM4,
unchanged); the app layer adds **ownership**. This is the truepoint-data mandate verbatim —
ownership is *"a filter dimension layered on top"* of the RLS hard boundary.

**Why not the user-GUC alternative** (add `app.current_user_id` + an RLS policy
`creator-or-elevated`):

1. **Product policy does not belong in DB policy.** The visibility rule is a *product* contract
   that will keep evolving — a per-job share flag (§2.3), a per-workspace import policy (§3),
   possible future team scoping (doc 14). Every iteration would be an RLS migration; and
   expressing "or the caller is an admin" in policy requires embedding a `tenant/workspace
   membership` subquery into every job-table policy — per-query cost on every read, and a
   coupling of the tenancy mechanism to a moving product rule. The tenant wall's value is
   precisely that it is *dumb and immovable*.
2. **GUC surface on pooled connections.** `withTenantTx` is correct today because it sets
   exactly two GUCs, LOCAL, fail-closed (`client.ts:82–91`) under RDS-Proxy transaction pooling.
   A third, user-identity GUC enlarges the fail-closed surface: every system path that touches
   job rows with **no user** — workers writing transitions, the completer, the reaper, rollups —
   would need a bypass branch in policy (`user GUC unset ⇒ ?`). Fail-closed would break the
   workers; fail-open would hollow out the policy. The app layer has no such dilemma: reads take
   a viewer, writes by workers don't (§4.3).
3. **DM4 locks tenancy as the two-tier tenant/workspace wall** — job tables copied the contacts
   RLS idiom (01 §5.1), and the contacts precedent (`owner_user_id` filter-only, 01 §6.4) is the
   deliberate, shipped shape of intra-workspace scoping. Job objects join that shape; they do
   not fork it.
4. **The market pattern needs app-layer expression anyway.** The dominant surveyed model is a
   *role-scoped shared list with attribution* (03 §5.1 [7][6][54]) — "admins see all with
   creator shown" is a join + a conditional predicate, natural in the repository, contorted in
   policy.

**Defence-in-depth note (truepoint-security):** this does *not* demote isolation to discipline.
The inter-tenant/inter-workspace wall — the catastrophic failure mode — remains RLS-enforced at
the database. The intra-workspace owner scope is a product-visibility rule among users who
already share the workspace's records (01 §6.4); its enforcement discipline is the compile-time
signature guard (§4) plus the per-surface isolation itests (§Testing), which is the same
discipline that guards every ownership filter in the product today.

### §2 The default policy matrix 🔲

#### §2.1 Verb × workspace-role matrix (uniform across import, reveal, enrichment)

**Definitions.** *Creator* = `created_by_user_id = viewer.userId` (import: also
`source_imports.imported_by_user_id` for provenance-derived surfaces). *Elevated* = workspace
`admin` or `owner`. *Shared* = the job row's `shared_with_workspace = true` (§2.3; no UX yet).
Role is always resolved server-side per request (`requireRole` → `getWorkspaceRole`), never from
the client.

| Verb | `viewer` | `member` | `admin` / `owner` | Notes |
|---|---|---|---|---|
| **List** (`GET /imports`, `GET /reveal-jobs`, `GET /jobs`, Recent Imports) | own + shared¹ | **own + shared** | **all, with creator attribution** | the G01 fix; HubSpot export-log split (03 §5.1 [7]) |
| **Detail by id** | same predicate as list | same predicate as list | all | identical predicate ⇒ no IDOR side-door (§4.2); invisible ⇒ **404**, never 403 (shipped posture, 01 §5.7 / `bulkRoutes.ts:242`) |
| **Create** (submit / commit / one-shot) | ✗ 403 | ✓ (default; workspace policy may raise to admin-only, §3) | ✓ | the G02 fix; today: no gate at all (`import/routes.ts:127`) |
| **Cancel** | creator only² | **creator** | all | Salesforce creator-or-named-permission abort rule (03 §5.1 [56]); rides 08 §2.2's stop-remainder semantics |
| **Retry failed rows** | creator only² | creator | all | creation-shaped: also requires the create grant (§3) |
| **Download error artifact** (rejected/repair CSV — **PII**) | ✗ | **creator only** | all | tightest gate — HubSpot importer-or-super-admin (03 §5.1 [6]); never widened by `shared_with_workspace` (share shares *metadata*, never artifacts); every download audited (§7) |
| **Manage mapping templates** | read/list only | create; edit/delete **own**; `workspace`-visibility templates readable by all (08 §3.1) | edit/delete any | today: ungated (`import-mapping-templates/routes.ts:55,81`) |
| **Manage import policy & strategy defaults** (§3) | ✗ | ✗ | ✓ | 08 §5's "org-admin workspace default" — its permission ride, landed here |

¹ Post-G02 a viewer creates nothing, so "own" is normally empty — the predicate still applies
uniformly (legacy rows; role downgrades). ² Creator-verbs are honored regardless of current
role: Salesforce's rule is "if you created it" (03 §5.1 [56]); a member demoted to viewer can
still cancel their own stuck job.

**Attribution is part of the contract, not garnish:** every all-visible list row carries
`createdBy { userId, displayName }` (join to `users`; HubSpot renders name + email, 03 §5.1
[6]). `created_by_user_id IS NULL` renders as **"System"** and is visible to elevated roles only
(§Edge cases).

#### §2.2 Row visibility vs record visibility

Scoping a job list does **not** scope the records the job created (the Salesloft distinction,
03 §5.1 [119]): contacts landed by member A's import remain workspace-visible per the record
model (§6.3). The job row is the activity artifact; the records are the shared dataset.

#### §2.3 The per-job share flag — column now, UX deferred 🔲

`shared_with_workspace boolean NOT NULL DEFAULT false` is added to `import_jobs`, `reveal_jobs`,
and `enrichment_jobs` in S-V1 and baked into the predicate from day one (§4.1), so shipping the
UX later is a UI change, not a schema/predicate migration. The UX itself is **deferred
deliberately**: no surveyed platform exposes per-job sharing (03 §5.1 [16][117]) — the
share-verb, its audit action, and its place in doc 11's surfaces enter the roadmap as a doc 14
future enhancement. Until then the column is written by nobody and read by the predicate
(constant `false` ⇒ zero behavior change).

### §3 G02 — naming the "import at all" grant 🔲

**Decision: reuse the workspace-role tier; add one per-workspace policy knob; invent no
permission system.**

- **The grant:** submitting an import (upload, commit, one-shot, retry-failed — every
  job-*creating* import verb, 08 §2.3) requires workspace role `member` or above:
  `requireRole("owner", "admin", "member")`. Viewer is a read-only role product-wide; today's
  zero-gate posture (any authenticated workspace user, `import/routes.ts:127`) ends.
- **The escape hatch:** a per-workspace **`import_policy`** row (one per workspace, mirroring
  the shipped `enrichment_policy` idiom — `schema/enrichmentPolicy.ts:24–43`) with
  `who_can_import` CHECK (`'member'`,`'admin'`) DEFAULT `'member'`. Set to `'admin'`, the create
  verbs additionally require elevated role. Managed by admins/owners (§2.1 last row); every
  change audited. The same row is the home 08 §5 reserved for the workspace **strategy
  defaults** (`default_merge_mode`, `default_preserve_populated`) — one policy object, one
  settings surface, one audit trail.
- **Why this and not per-user toggles:** the market ships import-at-all as an explicit per-user
  grant (HubSpot "Import" toggle, Outreach "CSV Import", Apollo per-profile — 03 §5.1
  [17][117][79][80][84]), which proves the *grant must be named* — but TruePoint's shipped
  permission primitives are roles, not per-user permission sets, and G02's severity (P1) does
  not justify a new IAM subsystem this series. Role-plus-policy expresses both surveyed
  postures: HubSpot-like broad default (`member`) and Outreach-like governed default (`admin`).
  A true per-user grant matrix (and HubSpot's approval ladder [17]) is recorded as a doc 14
  future enhancement layering on the same enforcement point.
- **Uniformity note:** reveal and enrichment job creation keep their existing create gates
  (member-tier `requireRole`; bulk-enrich additionally confirm-gated per prospect-platform I3) —
  `who_can_import` governs *imports* only. Extending policy knobs to other job families is doc
  14 territory; the *visibility* model (§2) is what applies uniformly today.

### §4 Repository-signature enforcement (load-bearing) 🔲

The named failure mode of any app-layer predicate is *omission on the next surface* — exactly
how the leak propagated to three live surfaces (02 §RC-1). The guard is the type system: **the
viewer context is a required parameter of every job-list/get repository method**, and the
predicate is applied **inside the repository**, never in routes.

#### §4.1 The signature shape (TS-ish; exact code at PR time)

```ts
// @leadwolf/types — WHO is looking. Constructed ONLY from middleware outputs.
export interface JobViewer {
  userId: string;          // claims.sub — the verified token, never the body
  role: WorkspaceRole;     // resolved by requireRole → getWorkspaceRole(c)
}

// packages/db — ONE predicate implementation, shared by every job repository.
function jobVisibility(viewer: JobViewer, cols: {
  createdByUserId: Column; sharedWithWorkspace: Column;
}): SQL | undefined {
  if (viewer.role === "owner" || viewer.role === "admin") return undefined; // all rows —
  // RLS has already walled the workspace; `undefined` = no FURTHER narrowing.
  return or(eq(cols.createdByUserId, viewer.userId), eq(cols.sharedWithWorkspace, true));
}

// Every job repository — viewer is REQUIRED (not optional, no default):
async listJobs(scope: TenantScope, viewer: JobViewer, page: KeysetPage): Promise<JobListRow[]>;
async getJob(scope: TenantScope, viewer: JobViewer, jobId: string): Promise<JobRow | null>;
// Verb guards run the SAME predicate before acting (creator-∪-elevated for cancel/retry;
// creator-∪-elevated, share-flag ignored, for artifacts):
async assertCanCancel(tx: Tx, viewer: JobViewer, jobId: string): Promise<JobRow>; // throws/404
```

#### §4.2 The three rules that make it enforcement, not convention

1. **Rename, don't overload.** The unpredicated readers (`listJobsByWorkspace` on
   `importJobRepository.ts:170`, `revealJobRepository.ts:168`,
   `enrichmentJobRepository.ts:229`; `recentBatches` on `sourceImportRepository.ts:105`) are
   **renamed** to the `listJobs(scope, viewer, …)` shape — the old names are deleted in the same
   change, so no call site (present or rebased-in) can keep compiling against a workspace-wide
   read. Omission of the predicate is a compile error, not a review catch.
2. **Detail-by-id applies the SAME predicate.** `getJob(scope, viewer, id)` narrows by
   `jobVisibility` exactly as the list does — otherwise a leaked/guessed id is an IDOR side-door
   around the list filter. Invisible (foreign-user or absent) ⇒ `null` ⇒ route 404s without
   revealing existence (matching the shipped posture, `enrichment/routes.ts:58`).
3. **Routes never assemble the predicate.** Handlers build `JobViewer` from
   `c.get("claims").sub` + `getWorkspaceRole(c)` and pass it down. A route computing its own
   `where` against a job table is a review-rejectable pattern; doc 16's audit checklist carries
   this as a standing invariant for any future job family (export jobs, verification jobs, …).

#### §4.3 Who does NOT take a viewer

Worker/system paths — state transitions, counter updates, the completer, reapers, rollups —
mutate by `jobId` on their existing scoped paths and take no viewer: they act on behalf of the
job, not a user. The viewer contract governs **user-facing reads and user verbs** exclusively,
which is what keeps the no-user-GUC decision clean (§1 point 2).

### §5 The propagation matrix — every surface from 01 §5, one predicate 🔲

Verb matrix = §2.1 in every row; "gate" = the rollout lever (§Rollout).

| # | Surface | Current predicate (01 §5.7) | Target predicate & mechanism | Step | Gate |
|---|---|---|---|---|---|
| 1 | **Import list** — `GET /imports` (08 S-I4; routes the dead repo read) | 🌒 unrouted; RLS workspace only (`importJobRepository.ts:170–177`) | `listJobs(scope, viewer, page)` — predicate baked in **before the route ever exists**; keyset on the S-V1 index | S-V2+S-V3 (rides 08 S-I4) | none — new endpoint, strict from day one |
| 2 | **Import detail** — `GET /imports/:id` (+ legacy `GET /imports/bulk/:jobId` through 08's window) | RLS + explicit workspace check (`bulkRoutes.ts:231–268`) | `getJob(scope, viewer, id)`; invisible ⇒ 404 | S-V2+S-V3 | dual-gate (live legacy surface) |
| 3 | **Legacy sync poll** — `GET /imports/:jobId` (Redis-backed, retiring per 08 §1.2) | workspace check on the Redis payload (`routes.ts:173–176`) | same rule app-side: payload `importedByUserId` vs viewer (creator ∪ elevated) until the read retires | S-V3 | dual-gate |
| 4 | **Import cancel / retry-failed** — new verbs (08 §2.3) | — (G05: no route exists) | `assertCanCancel` (creator ∪ elevated) + create-grant for retry (§3) | S-V3 (rides 08 S-I4/S-I10) | none — new verbs |
| 5 | **Import error artifacts** — `GET /imports/:id/artifacts/:kind` (08 S-I7) | — (bulk poll returns a signed URL to any workspace member, `bulkRoutes.ts:250–253` — closes with the route) | creator ∪ elevated, share-flag ignored; signed expiring URL; download audit (§7) | S-V5 (rides 08 S-I7) | none — new endpoint |
| 6 | **Reveal list** — `GET /reveal-jobs` ✅ live | `requireRole(4 roles)` + workspace-only (`reveal/routes.ts:201–208` → `revealJobRepository.ts:168–176`) | route passes `JobViewer`; repo renamed/predicated | S-V2+S-V3 | **dual-gate** (narrows live behavior) |
| 7 | **Reveal detail** — `GET /reveal-jobs/:jobId` ✅ live | workspace-only (`revealJobRepository.ts:179–186`) | same predicate (IDOR rule §4.2) | S-V2+S-V3 | dual-gate |
| 8 | **Enrichment list + detail** — `GET /jobs`, `GET /jobs/:jobId` ✅ live | `requireRole(4 roles)` + workspace-only (`enrichment/routes.ts:47–56` → `enrichmentJobRepository.ts:229–233`) | viewer through `listEnrichmentJobs` → predicated repo; enrichment confirm/cancel verbs (I3) = creator ∪ elevated | S-V2+S-V3 | dual-gate |
| 9 | **Recent Imports card** — `GET /home/summary` → `recentBatches` ✅ live | workspace-only grouping (`sourceImportRepository.ts:105–129`); `imported_by_user_id` unused | predicate pushed **into** `recentBatches(scope, viewer, …)` on `imported_by_user_id`: members see own batches; elevated see all with attribution. Card copy/toggle alignment is doc 11's (members' card reads "Your recent imports"; an admin sees the workspace view) | S-V2+S-V3 | dual-gate |
| 10 | **Mapping templates** — `GET/POST/DELETE /imports/mapping-templates` ✅ live | ungated beyond workspace (`import-mapping-templates/routes.ts:47–86`) | §2.1 template row: member manages own, elevated manages any; `visibility='private'` rows creator-only in lists (08 S-I2 column) | S-V4 | dual-gate (write-gates on a live surface) |
| 11 | **Import policy & strategy defaults** — new settings surface (§3) | — | `requireRole("owner","admin")`; audited writes | S-V4 | none — new |

**Uniformity invariant (standing):** any future tenant-facing job family ships its list/detail
reads on the `JobViewer` signature or does not ship — recorded in doc 16's checklist and tested
per §Testing.

### §6 What does NOT change (scope walls) ✅

1. **Staff surfaces stay staff-locked, unchanged.** `GET /admin/import-jobs`
   (`admin/routes.ts:1159–1168`, `requireStaffRole`, audited `withPlatformTx`) and the data-ops
   panel (`requireCapability("data:read")` per route) are correctly locked today (01 §5.6) and
   are out of scope. The Surface-1/Surface-2 wall is restated: no staff cap in `apps/web`
   gates, no workspace/org role in `/admin/*` (a crossover is a P1 finding per
   db-mgmt-research/12).
2. **RLS and the tx wrappers are untouched.** No policy DDL, no new GUC, no change to
   `withTenantTx`/`withErTx`/`withPlatformTx`; the one sanctioned staging bypass (07 §5) is
   unaffected.
3. **Record visibility is explicitly NOT redesigned.** Contacts and accounts remain
   workspace-visible; `contacts.owner_user_id` remains a filter dimension, never a per-row
   access wall (01 §6.4). **This doc is about JOBS** — activity/job artifacts gain owner scope;
   the dataset those jobs produce stays the workspace's shared asset (§2.2). A record-sharing
   redesign would be its own engagement against the truepoint-data ownership model.
4. **Job *writes* by workers/system paths** keep their current mechanics (§4.3); this doc adds
   no worker-side checks.

### §7 Abuse resistance — limits, download audit, enumeration 🔲

- **Job creation:** the per-workspace commit quota (default 20/h) and per-route rate limits are
  08 §2.3's contract (published in doc 12); the §3 create-gate stacks on top. No separate
  per-user quota is designed until abuse data demands it (doc 14).
- **Artifact downloads (PII egress):** a stricter per-user rate bucket than plain reads; URLs
  are signed and expiring (08 S-I7); **every download writes an in-tx `audit_log` row**
  (`import.artifact_downloaded` — jobId, artifact kind, actor, IP) — the HubSpot
  who-downloaded-with-IP-and-date precedent (03 §5.1 [7]) and the 03 §5.1 [27] audit-fallback
  pattern. Repeated downloads by non-creators (i.e., admins sweeping artifacts) are visible in
  the trail by construction.
- **Enumeration resistance:** ids are UUIDs; invisible ⇒ 404 identical to absent (never 403 —
  no existence oracle; shipped posture `bulkRoutes.ts:242`); list cursors are opaque keyset
  cursors (house API contract); detail endpoints sit behind the standard rate limiter so id
  probing is throttled and, past the predicate, yields nothing but 404s.

---

## Implementation Steps (step IDs — doc 15 sequences; no fixed migration numbers)

| Step | What ships | DDL | Depends on |
|---|---|---|---|
| **S-V1** | Additive schema: `shared_with_workspace boolean NOT NULL DEFAULT false` on `import_jobs` / `reveal_jobs` / `enrichment_jobs` · member-list keyset index `(workspace_id, created_by_user_id, created_at DESC, id DESC)` on each job table (+ `source_imports (workspace_id, imported_by_user_id, imported_at DESC)`) · `import_policy` table (uniq per workspace: `who_can_import` CHECK default `'member'`; strategy-default columns for 08 S-I6; `updated_by_user_id`, timestamps) | Yes | — |
| **S-V2** | `JobViewer` in `@leadwolf/types`; the shared `jobVisibility` predicate in `packages/db`; repository renames — `listJobs`/`getJob` (+`recentBatches`) take required viewer; old unpredicated names deleted; attribution join (creator display name) in list rows | No | S-V1 |
| **S-V3** | Route wiring: viewer passed on reveal/enrichment/home + import detail/legacy poll; new import list/cancel/retry ride 08 S-I4 with the predicate from birth; dual-gate `JOB_VISIBILITY_SCOPED` env + per-tenant `job_visibility_scoped` flag — **flag-off ⇒ predicate short-circuits to workspace-wide (byte-identical current behavior)** | No | S-V2; 08 S-I4 for the new routes |
| **S-V4** | G02: `requireRole("owner","admin","member")` on every import-creating verb + `import_policy.who_can_import` enforcement; template manage-gates + `visibility='private'` list filtering (08 S-I2 column); policy settings endpoint (admin-only, audited) | No | S-V1; dual-gated with S-V3's flag |
| **S-V5** | Artifact gate (creator ∪ elevated) + download audit action + stricter download rate bucket | No | S-V2; 08 S-I7 |
| **S-V6** | Rollout completion: per-tenant flag default-on for new tenants → staged flip per 14 Phase 0 comms → flag retirement (predicate becomes unconditional; short-circuit branch deleted) | No | S-V3–S-V5 baked; 14 §Phase 0 |

---

## Pre-build reasoning pass (explicit answers)

Per `truepoint-architecture/references/pre-build-thinking.md`; answers cite the owning skills.

- **Source of truth.** Visibility policy: the §2.1 matrix, implemented once in `jobVisibility`
  (packages/db) — no duplicate policy in routes or the frontend (UI hiding is UX, not a
  boundary — truepoint-security). Viewer identity: the verified token + per-request role
  resolution (`requireRole`); never cached client-side, never in the body. Import permission
  policy: the `import_policy` row. Share state: the job row's column.
- **Failure modes.** *Predicate omitted on a future surface* (the defining one): compile error —
  the viewer parameter is required and the unpredicated method names no longer exist (§4.2.1);
  belt-and-braces via the per-surface isolation itests and the doc-16 invariant. *Role lookup
  fails:* `requireRole` 403s fail-closed (shipped). *Flag service unreachable:* per-tenant flag
  read is fail-closed to OFF (shipped `flagsForTenant` posture) ⇒ legacy-wide visibility during
  the rollout window, never an error page; post-S-V6 the branch is gone. *Attribution join
  misses (deleted user):* render "Former member", never a broken row.
- **Duplicate prevention.** Not create-shaped; the verbs this doc gates inherit 08 §2.3's
  idempotency (cancel idempotent; retry replay-safe). `import_policy` upserts on its workspace
  unique.
- **Audit.** Policy changes, template manage-verbs, cancels/retries, and every artifact download
  are in-tx `audit_log` writes with actor + action + target (08 §7's discipline); the download
  action is this doc's addition (§7).
- **Security (the threat checklist, answered).** *Access:* every endpoint in §5 runs
  `withTenantTx` (RLS tenant wall) **and** the ownership predicate — tenant-scoped +
  owner-checked, per the mandate. *IDOR:* detail-by-id shares the list predicate (§4.2.2);
  probes get 404. *Authorization:* every verb = role gate + data-scope predicate, both
  server-side. *Privilege escalation:* role comes from membership lookup, never the client;
  `shared_with_workspace` is writable by no route until doc 14; policy writes are admin-gated +
  audited. *Data exposure:* list rows are the non-PII control-row columns (shipped repo
  discipline) + creator display name; artifacts (the PII) take the tightest gate + audit.
  *Worst case — PII artifact leak:* bounded by creator-∪-elevated + signed expiring URLs +
  download audit + rate bucket; detectable (audit trail), recoverable (URL expiry + gate).
  *Second worst — over-narrowing breaks live users:* flag-off restores current behavior
  byte-identically (§Rollout).
- **Scalability.** The predicate adds an equality/OR over indexed columns (S-V1 composite
  indexes match the member path; the elevated path keeps the existing workspace keyset index,
  07 §4.3/08 S-I1). No new N+1: attribution is one join in the same list query; role resolution
  is the existing per-request lookup `requireRole` already performs on these routes. At 10x,
  job lists stay keyset-bounded — nothing here changes list cardinality.
- **Monitoring.** Counters: lists served by viewer-role class; 403s on create verbs (spike =
  mis-set policy); artifact-download audit volume (alert on anomaly); flag-state gauge per
  tenant during rollout. The cross-user isolation itests are the regression tripwire.
- **Rollback.** S-V1 is additive DDL with written down-migrations; S-V3/S-V4 behavior sits
  behind the dual gate — env kill-switch off = instant fleet-wide revert to current visibility,
  per-tenant flag = granular revert; S-V6 removes the lever only after the bake period doc 14
  sets. Doc 15 owns the rehearsal.
- **Edge cases.** See §Edge Cases below.
- **Assumptions.** (1) Workspace role is the right granularity — teams stay grouping-only
  (01 §6.4); if team-scoped job visibility is ever demanded, it extends `jobVisibility`, not the
  schema. (2) Creator columns are reliably populated on user-initiated jobs (verified:
  `bulkRoutes.ts:190`; reveal/enrichment creates stamp `claims.sub`) — the null path is
  system-only. (3) Job-list volumes stay control-row-sized (bounded by the commit quota).
- **Misuse / load.** Covered in §7 (quotas, buckets, enumeration); no unbounded reads exist on
  any §5 surface.
- **Worst case.** Named above under Security — both branches detectable and recoverable; no
  maker-checker escalation needed beyond the flags (nothing here is destructive).

---

## UI/UX (pointer — doc 11 owns every surface)

Doc 11 consumes: the imports history page rendered from the §2.1 matrix (members: "your
imports"; elevated: workspace view with a "Created by" column — attribution is a first-class
column, 03 §5.1 [6]); the Recent Imports card copy split (§5 row 9); disabled-with-reason states
for create verbs under an `'admin'`-only policy (viewers/members see an honest "imports are
admin-managed in this workspace" state, not a hidden button — four-states discipline); the
policy settings panel (admin settings area); cancel confirmation carrying 08 §2.2's
stop-remainder copy. No share-flag UX ships this series (§2.3).

## DB & Backend (summary)

S-V1 DDL only — all additive; no RLS/policy DDL; no column renamed or repurposed. Code lands in
existing homes: `packages/types` (`JobViewer`, policy schemas), `packages/db` (predicate +
repository signatures — `importJobRepository`, `revealJobRepository`, `enrichmentJobRepository`,
`sourceImportRepository`), `apps/api` route wiring (`import/`, `reveal/`, `enrichment/`,
`home/`, `import-mapping-templates/`, new `import-policy` settings routes), zero worker changes.

## API (summary)

No new public shapes beyond: list-row `createdBy` attribution fields, the `import_policy`
settings resource (GET/PUT, admin-gated, shared Zod in `@leadwolf/types`), and 403 problems on
the newly gated verbs (`insufficient_role` — the shipped slug from `requireRole`;
`import_disabled_by_policy` for the §3 knob). All `/api/v1`, RFC 9457, keyset cursors unchanged.
Invisible resources are 404, indistinguishable from absent (§7).

## Edge Cases

- **`created_by_user_id IS NULL` (system/automation jobs):** visible to elevated roles only;
  attributed "System". Members never see them (they are nobody's "own").
- **Creator left the workspace / deactivated:** rows persist; elevated roles still see them;
  attribution renders "Former member"; creator-verbs die with the departed session (elevated
  roles retain cancel/artifact access — the admin-override existing exactly for this).
- **Role changes mid-session:** role is resolved per request from membership (`requireRole.ts:21`)
  — a demotion takes effect on the next request; nothing is cached in the token.
- **Pre-existing rows at flag-flip:** historical jobs by other members drop out of a member's
  list the moment the flag turns on — intended and part of the 14 Phase 0 comms; no data
  changes, only visibility.
- **Aggregates must ride the same predicate:** the home summary fan-out passes the viewer into
  `recentBatches` (§5 row 9); any future count/badge endpoint uses the predicated repo methods —
  a count that disagrees with its list is a bug class the T-V tests cover.
- **Keyset stability under the predicate:** cursors remain `(created_at, id)`; the member-path
  composite index (S-V1) keeps the narrowed scan ordered without a sort node.
- **`who_can_import='admin'` with in-flight member jobs:** policy gates *creation* only;
  existing jobs finish, remain visible per §2.1, and stay cancellable by their creators.

## Testing (hooks — CI-run; this sandbox cannot execute gates)

- **T-V1 Cross-USER isolation (new test class, beyond cross-tenant), per surface:** seed one
  workspace, users A (member), B (member); B's jobs invisible to A on every §5 list; A's
  `GET` on B's job id ⇒ 404; A's cancel/retry/artifact on B's job ⇒ 404, nothing written. Runs
  against import, reveal, enrichment, and recentBatches.
- **T-V2 Admin override:** admin/owner sees A's + B's jobs with correct `createdBy` attribution;
  system (null-creator) rows appear for elevated only.
- **T-V3 IDOR probe:** direct detail-by-id with guessed/leaked foreign-user ids ⇒ 404
  indistinguishable from absent; response timing/shape identical.
- **T-V4 Flag-off parity:** `JOB_VISIBILITY_SCOPED` off ⇒ responses byte-identical to shipped
  behavior on every live surface (the 15 §8 parity discipline).
- **T-V5 Share flag:** row with `shared_with_workspace=true` visible to members in list/detail
  but its artifacts still creator-∪-elevated only.
- **T-V6 Create gates (G02):** viewer submit ⇒ 403; member submit under `'admin'` policy ⇒ 403
  `import_disabled_by_policy`; admin unaffected; policy write by member ⇒ 403; policy change
  audited.
- **T-V7 Download audit:** every artifact download writes the audit row (actor, jobId, kind,
  IP); denied attempts write nothing but return 404/403 per matrix.
- **T-V8 Signature guard (meta):** compile-time — a call site invoking a job list/get without a
  `JobViewer` fails typecheck (guaranteed by S-V2's rename); plus a repo-level grep test
  asserting no exported job-read named `*ByWorkspace` remains.
- Cross-refs: 08 T2 (its list-endpoint isolation case is T-V1's import row); doc 13 owns
  artifact-content redaction tests.

## Rollout

New surfaces (import list/cancel/artifacts, policy) ship strict from birth — no legacy behavior
to preserve. Live surfaces (reveal list/detail, enrichment list/detail, Recent Imports, template
gates) narrow behind the dual gate: `JOB_VISIBILITY_SCOPED` env (fleet kill-switch) + per-tenant
`job_visibility_scoped` flag (seeded off; the shipped generic flag console surfaces it) —
**because this narrows what live members can see, it is a communicated product change, not a
silent fix**: internal workspaces first → new tenants default-on → staged tenant flip with the
doc 14 Phase 0 comms (release note + in-app notice "job lists now show your own jobs; admins see
all") → S-V6 removes the branch. Rollback at any stage = flag off (byte-identical legacy
visibility, T-V4); full rollback rehearsal and sequencing: doc 15. The G02 create-gate rides the
same flag so a tenant's behavior changes once, not twice.

## Success Metrics

- **THE bug closed:** with the flag on, 0 member-visible foreign jobs on any §5 surface —
  T-V1 green forever; the reported defect class unreproducible.
- **No isolation regressions:** cross-tenant + cross-user itest suites both green in every CI
  run; T-V8 keeps the unpredicated read extinct.
- **IDOR-proof:** detail probes on foreign ids ⇒ 100% 404; zero existence oracles in scans.
- **Artifact accountability:** 100% of error-artifact downloads carry an audit row; 0 downloads
  by non-creator non-elevated users.
- **G02 landed without friction:** <1% of import attempts 403 on role/policy post-comms
  (baseline sanity that the default `'member'` posture matches real usage); 0 support tickets
  about "import button gone" from members in default-policy workspaces.
- **Rollout health:** 100% tenants flipped by the doc 14 date; flag branch deleted (S-V6);
  support ticket rate on "can't see my teammate's import" resolved by the admin-view answer, not
  by flag reverts (reverts = 0 steady-state).
