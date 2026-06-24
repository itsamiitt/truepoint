# Email Subsystem — Roles & Permission Boundaries (12)

> **Status:** Plan (not yet built). **Owner:** Security + Platform. **Last updated:** 2026-06-24.
> This doc defines **who sees what and who can do what** in the email subsystem, and the
> **boundaries** that make those answers safe. It is the governance contract for the surfaces in
> `10-web-surface.md` (customer) and `11-admin-surface.md` (platform-admin); it realizes **D8**
> (owner-scoped visibility by default — cross-rep visibility needs manager/admin) and the
> reputation-isolation half of **D2**. It mirrors the governance shape of
> `../list-plan/07-admin-staff-governance.md` and reuses the same platform/staff machinery.
>
> **Precedence (root `CLAUDE.md`):** **Security has the final say on access.** Every **✓** below is
> defensible; every **—** is enforced by a real mechanism — the **two-check rule** (permission AND
> data-scope), **RLS**, and **IDOR→404** — not by hiding a button in the UI. Platform owns the
> tenancy/API mechanism; Data owns the ownership semantics this doc reads from (`09-data-model.md`).
>
> **No raw secrets, ever (D7):** no role — Rep, Manager, Tenant Admin, or Platform Admin — can read
> a mailbox or provider credential. Secrets stay server-side; this whole permission set governs
> *actions*, never *secret material*.

---

## 1. The principle (D8): owner-scope by default; cross-rep needs a role

A Rep's email work — their `email_template`s, their `email_sequence`s, the `email_send`s they made,
the analytics over them — is **theirs**. The default answer to "can user X see user Y's email
object?" is **no**. Visibility widens only by an **explicit share** or by holding a **workspace
role** (Manager/Admin) that confers team-wide reach. This is **D8**, and it is non-negotiable:

- **Default = owner-scoped.** A Rep sees their own templates/sequences/sends/analytics, plus
  anything **explicitly shared** with them (`09 §share model`), plus what their workspace role
  confers. They do **not** see another Rep's drafts, enrollments, or per-message results.
- **Cross-rep visibility is a role, not a setting.** A Manager sees the team; a Tenant Admin sees
  the workspace/tenant; a Platform Admin sees across tenants only through **audited break-glass**
  (§7). There is no "make my sends visible to everyone" toggle that bypasses this.
- **Reputation isolation is per-tenant (D2).** A tenant admin governs their *own* tenant's
  `sending_domain` / Reputation Pool / Warmup; a Platform Admin governs **across** tenants. No
  tenant ever sees, shares, or borrows another tenant's reputation, mailboxes, or suppression.
- **Aggregate, never row-level PII, for the product side.** Platform-admin analytics over email are
  **counts and rates** (deliverability, queue depth, pool health), never the recipient lists or
  message bodies behind them (§7).

This stance is **stronger** than "trust the role". The control is technical — the two-check rule
(§4) plus FORCE-RLS (`packages/db`) — so it holds even against a curious or compromised account.
Enterprise engagement platforms model exactly this gradient: Outreach scopes visibility by role and
team, with admins configuring what reps and managers can see across the org [Outreach,
*Admin & Roles*]; Salesloft ships rep/manager/admin tiers where managers gain team-level reporting
and admins gain org-wide configuration [Salesloft, *Roles & Permissions*]; HubSpot gates Sales-hub
features behind granular per-user permissions with "Everything / Team only / Owned only" data
scopes [HubSpot, *User Permissions*]. TruePoint adopts the same gradient and binds it to its own
tenancy and RLS.

---

## 2. The four roles and the middleware they map onto

The email subsystem invents **no new role enum**. It maps its four narrative roles onto TruePoint's
**existing** three-tier model and the existing middleware chain
(`authn → tenancy → requireRole → handler`, plus the `platformAdmin` gate). The tiers are
deliberately separate — never merged.

| Narrative role | TruePoint tier | Concrete role(s) | Resolved / gated by | Scope |
|---|---|---|---|---|
| **Rep** | Workspace | `member` | `requireRole("member", ...)` (`apps/api/.../middleware/requireRole.ts`) | their own email objects + explicit shares, within one workspace |
| **Manager** | Workspace | `admin` (and `owner`) | `requireRole("admin")` | **team** — all email objects in the workspace they administer |
| **Tenant Admin** | Tenant / Org | `owner`, `security_admin`, `compliance_admin` | `requireOrgRole(...)` (`requireOrgRole.ts`; `owner` always passes) | **workspace/tenant-wide** config: mailboxes, domains, suppression, reputation, consent |
| **Platform Admin** | Platform / staff | `super_admin`, `support`, `compliance_officer`, `billing_ops`, `read_only` | `platformAdmin` (`pa` claim) **then** `requireStaffRole(...)` | **cross-tenant**, aggregate-only by default; row-level only via audited break-glass (§7) |

Resolution is **per-request from the DB** (workspace role from `workspaceRepository`, org role from
`tenantMemberRepository`, staff role from `platform_staff`), so a revoke takes effect on the **next
request** with no stale-JWT window. The `pa` claim is **server-set and rides the signed JWT** — it
cannot be forged from the request body. Platform-admin routes are **not** workspace-scoped (they
read across tenants via the audited `withPlatformTx` path); customer routes always pass through
`tenancy` first so `tenant_id`/`workspace_id` come from the **session, never the request**.

> Within a workspace, `viewer` is the read-only customer role. For email it sees what a Rep would
> see **read-only within its own scope** (no `email.send`, no `email.sequence.enroll`, no writes).
> It is folded into the Rep column of the matrix as the non-write floor.

### 2.1 What each role SEES and DOES (narrative)

**Rep (workspace `member`).** *Sees:* their own templates and the versions they authored
(`email_template`/`email_template_version`), templates **shared** to them or workspace-published;
their own sequences and the enrollments they created; the sends they made and the tracking events on
them; **their own** analytics (`email.analytics.own`). *Does:* create/edit/share/delete their **own**
templates; create sequences and **enroll** prospects they own into them; **send** (subject to D4
suppression gate + D9 compliance); connect **their own** mailbox (`email.mailbox.connect` for self);
view suppression as it **affects their sends** (read). *Cannot:* see another Rep's drafts/enrollments
(D8); manage the workspace's domains/pools/warmup; manage team or tenant suppression; read any
secret (D7); transfer ownership of an object they do not own.

**Manager (workspace `admin`/`owner`).** *Sees:* **everything a Rep sees, team-wide** — every
template, sequence, enrollment, and send in **their workspace**, plus **team analytics**
(`email.analytics.team`). *Does:* everything a Rep does, plus: pause/stop any sequence in the team
(`email.sequence.pause`), reassign/transfer ownership of a team member's email objects (privileged +
audited, §5), manage the team's shared template library, and view team deliverability
(`email.deliverability.view` scoped to the team's mailboxes). *Cannot:* connect/disconnect the
tenant's `sending_domain` or manage Reputation Pools/Warmup (that is Tenant Admin); manage
tenant-wide suppression/consent policy; cross into another workspace; read secrets.

**Tenant Admin (org `owner`/`security_admin`/`compliance_admin`).** *Sees:* workspace/tenant-wide
configuration and **workspace analytics** (`email.analytics.workspace`): all mailboxes
(`mailbox_integration`, **metadata + status, never the secret**), all `sending_domain`s and their
DNS/auth posture, the tenant's Reputation Pools and Warmup state, the **tenant** and **workspace**
suppression and consent ledgers. *Does:* connect/disconnect/verify sending domains; create and
assign Reputation Pools; start/govern Warmup; manage **tenant- and workspace-scoped** suppression
(`email.suppression.manage`) and consent (`email.consent.manage`); set tenant email policy (sending
windows, per-mailbox caps that feed D10 fan-out, compliance defaults from `06`); read full
deliverability (`email.deliverability.view` tenant-wide). Specific org sub-roles narrow this:
`security_admin` owns mailbox/domain/secret-rotation governance; `compliance_admin` owns
suppression/consent/DSAR; `owner` covers all. *Cannot:* read raw secrets (D7 — they *rotate* and
*manage*, they never *see* the credential bytes); reach another tenant; see message **bodies/PII** of
sends except as the data model already permits for in-tenant operational need — and even then via
the same owner/role/share rules, never a blanket "read all message contents".

**Platform Admin (platform staff, behind `pa` + `requireStaffRole`).** *Sees (default):*
**cross-tenant aggregate** signals only — provider/pool health, queue depth and DLQ for the email
fan-out (D10), domain-auth posture rollups, deliverability **rates**, suppression **counts**, and
the email feature-flag/rollout state (`11-admin-surface.md`). They see **list metadata** (which
tenant has how many domains/mailboxes/sequences) — **never** message bodies, recipient lists, or
template contents by default. *Does:* operate the shared sending infrastructure (D1 hybrid provider
config, pool topology), manage **platform-level** suppression (`email.admin.suppression`, global DNC
that gates every tenant per D4), govern reputation across tenants (D2's cross-tenant half), flip
email feature flags, and — only when genuinely necessary — start an **audited break-glass
impersonation** (§7) to reach one tenant's email contents. *Cannot:* browse any tenant's recipients,
bodies, or analytics **at will** (the default platform path is aggregate-only and IDOR→404 protects
direct object access); read any secret (D7); cross-tenant **without** the `pa` claim **and** a staff
role **and** — for content — an audited session. `super_admin` implies every staff capability;
`billing_ops`/`read_only` cannot impersonate (mirrors `../list-plan/07 §4`).

---

## 3. The `email.*` permission set

Permissions live as an **enum in `@leadwolf/types`** (`email.*`) and are **checked in
`packages/core/src/email/`** as the function-level half of the two-check rule (§4). Holding a
permission is **necessary, never sufficient** — every permission below is paired at the handler with
a **data-scope** check. Permissions are grouped by object.

### 3.1 Templates
- `email.template.create` — author a new `email_template` (+ first `email_template_version`).
- `email.template.edit` — edit a template you own / a shared template you have edit-share on.
- `email.template.share` — grant another user/workspace access to a template you own (creates an
  explicit share row; references-not-copies).
- `email.template.delete` — delete/retire a template you own (Manager may delete team templates).
- `email.template.publish` — publish a template to the **workspace** library (Manager/Admin).

### 3.2 Sequences & enrollment
- `email.sequence.create` — create an `email_sequence` (+ `email_sequence_step`s).
- `email.sequence.edit` — edit a sequence you own / are shared on.
- `email.sequence.enroll` — create an `email_enrollment` (enroll a prospect **you own** into a
  sequence you may run). Enrollment is owner-checked: you cannot enroll a prospect you cannot see.
- `email.sequence.pause` — pause/resume an enrollment or a whole sequence (Rep: own; Manager: team).
- `email.sequence.stop` — hard-stop / unenroll (same scoping).

### 3.3 Sending
- `email.send` — produce an `email_send`. Always passes the **D4 suppression gate** and **D9
  compliance** in the same transaction; always idempotent (**D5**, via `email_idempotency_key`); the
  recipient/template/mailbox IDs supplied by the client are **re-resolved server-side and
  ownership-checked**, never trusted (§4).

### 3.4 Mailboxes
- `email.mailbox.connect` — connect a `mailbox_integration` (Rep: own mailbox; Tenant Admin: any in
  tenant). The OAuth/credential exchange is server-side; the stored secret is **never** returned (D7).
- `email.mailbox.manage` — configure caps/sending windows/disable/disconnect a mailbox; Tenant Admin
  for shared/team mailboxes, Rep for their own.

### 3.5 Sending domains, reputation, warmup
- `email.domain.manage` — connect/verify/remove a `sending_domain`, manage SPF/DKIM/DMARC posture and
  the **custom tracking domain** (D3). **Tenant Admin** only.
- `email.reputation.manage` — create/assign Reputation Pools; govern per-tenant isolation (D2).
  **Tenant Admin** for own tenant; **Platform Admin** across tenants.
- `email.warmup.manage` — start/pause/configure Warmup. **Tenant Admin** (own) / **Platform Admin**
  (cross-tenant infra).

### 3.6 Suppression & consent
- `email.suppression.view` — read suppression as it affects scope you can see (Rep: how it gates own
  sends; Tenant Admin: tenant/workspace ledger).
- `email.suppression.manage` — add/remove `email_suppression` rows at **workspace** or **tenant**
  scope (Tenant Admin / `compliance_admin`). Suppression gates **every** send (D4).
- `email.consent.view` / `email.consent.manage` — read / manage the `email_consent` ledger
  (Tenant Admin / `compliance_admin`); consent feeds D9.

### 3.7 Deliverability & analytics
- `email.deliverability.view` — view deliverability posture (auth pass rates, bounce/complaint rates,
  pool health). Rep: own sends; Manager: team; Tenant Admin: tenant.
- `email.analytics.own` — analytics over the caller's **own** email objects (D8 default).
- `email.analytics.team` — analytics across the **workspace team** (Manager). Ties to `08 §team`.
- `email.analytics.workspace` — workspace/tenant-wide analytics (Tenant Admin). Ties to
  `08 §workspace`.

> **Opens are informational, not a KPI (D6).** Wherever a permission grants analytics, open-rate is
> shown as **context**, never as the headline metric or a gate; bounce/complaint/reply/auth-pass are
> the real signals. The permission decides *who sees the numbers*, not *which numbers matter*.

### 3.8 Platform-admin (`email.admin.*`)
- `email.admin.provider` — manage the hybrid provider config / pool topology (D1).
- `email.admin.reputation` — govern reputation **across** tenants (D2 cross-tenant half).
- `email.admin.suppression` — manage **platform/global** suppression (global DNC; gates every tenant,
  D4).
- `email.admin.deliverability` — view cross-tenant deliverability **aggregates** (rates, DLQ, queue
  depth for the D10 fan-out).
- `email.admin.flags` — manage email feature flags / rollout (P0–P6, §8).
- `email.admin.impersonate` — start an **audited break-glass** session to reach one tenant's email
  contents (§7). `super_admin`/`support` only.

All `email.admin.*` permissions require the **`pa` claim** (the `platformAdmin` gate) **plus** the
appropriate **`requireStaffRole`** — two gates before any handler runs.

---

## 4. Permission boundaries — the two-check rule

A permission tells you the caller is *allowed to perform this kind of action*. It does **not** tell
you they are allowed to touch **this specific object**. TruePoint security mandates **defence in
depth**: **permission AND data-scope, two independent checks, either alone insufficient.** Every
email handler enforces both.

1. **Check 1 — permission (function-level authz).** Does the caller hold the `email.*` permission for
   this route? Resolved from the live role via the existing middleware (`requireRole` /
   `requireOrgRole` / `platformAdmin`+`requireStaffRole`). Fail → `403` RFC 9457 Problem.
2. **Check 2 — data-scope (object-level authz).** Is *this object* within the caller's scope under
   **D8**? The scope ladder:
   - **owner-scope** — `owner_user_id === caller` (Rep default);
   - **explicit share** — a share row grants the caller access (references-not-copies);
   - **workspace-wide** — caller's `workspace_id` matches **and** their role (Manager/Admin) confers
     team reach;
   - **tenant-wide** — caller's org role confers tenant reach (Tenant Admin);
   - **platform** — `pa` + staff role, **aggregate-only** by default, row-level only via §7.
   This is enforced **at the database via FORCE-RLS** (`tenant_id`/`workspace_id` from the session
   GUC) **and** re-asserted in `packages/core/src/email/` ownership checks — the UI is never the
   boundary.

**Both must pass.** A Manager has `email.sequence.pause` (Check 1) but pausing a sequence in
**another** workspace fails Check 2. A Rep with a valid `email.send` permission cannot send *as*
another Rep's mailbox because the mailbox ID re-resolves to an object outside their scope.

**IDOR → 404, not 403.** When Check 2 fails because the object is **outside the caller's scope**, the
API returns **`404 Not Found`**, **indistinguishable from "does not exist"** — never a `403` that
would confirm the object exists. A Rep poking `GET /api/v1/email/sequences/{someone-elses-id}` learns
nothing: the row is simply not there for them (RLS returns no row → 404). (A genuine
*permission-missing* failure on an object you *can* see returns `403`; the 404 is specifically the
**cross-scope / non-existent** case.)

**Client-supplied IDs are never trusted for authorization.** Template IDs, sequence IDs, mailbox IDs,
recipient/prospect IDs, list IDs — all arrive from the client as *claims about what to act on*, never
as *proof of access*. Every one is **re-resolved server-side under the caller's RLS scope**; if it
doesn't resolve in scope, it's a 404. This is why `email.send` cannot be tricked into sending from
another tenant's `sending_domain` or another Rep's `mailbox_integration` — the IDs simply don't
resolve.

**Tenant context comes from the session, never the request.** `tenant_id`/`workspace_id` are set from
the verified session by the `tenancy` middleware into the RLS GUCs; no email endpoint reads them from
the body or query. Reputation isolation (D2) and suppression scope (D4) ride on this — a request
cannot assert "I am tenant B" to borrow B's pool or escape A's suppression.

**Ownership transfer is privileged and audited.** Reassigning the `owner_user_id` of an
`email_template`/`email_sequence`/`email_enrollment` (e.g. when a Rep leaves or a Manager rebalances)
is **not** an ordinary edit. It requires a Manager/Tenant-Admin permission, passes both checks, and
writes an **audit row** (actor, object, old owner, new owner, reason, time). Transfer moves the
**reference**, never copies the data; suppression/consent state travels with the object. This mirrors
the platform-wide "ownership transfer privileged + audited" rule (`CLAUDE.md`, `09-data-model.md`).

---

## 5. Owner-scope vs workspace vs tenant vs platform — the boundary table

| Boundary | What it means for email | Who holds it | Enforced by |
|---|---|---|---|
| **owner-scope** | Your own templates/sequences/sends/enrollments + their analytics (`email.analytics.own`) | Rep (workspace `member`) | `owner_user_id` predicate under FORCE-RLS + core ownership check |
| **explicit share** | Another user's email object you were granted (references-not-copies) | any role, on grant | share row checked in Check 2; revocable; no copy made |
| **workspace-wide** | Every email object in the workspace (`email.analytics.team`) | Manager (workspace `admin`/`owner`) | `workspace_id` GUC + role gate (`requireRole("admin")`) |
| **tenant-wide** | Mailboxes, domains, pools, warmup, suppression, consent, workspace analytics | Tenant Admin (`requireOrgRole`) | `tenant_id` GUC + org-role gate |
| **platform** | Cross-tenant aggregate ops; row-level only via audited break-glass | Platform Admin (`pa` + staff role) | `platformAdmin` + `requireStaffRole`; `withPlatformTx`; impersonation (§7) |

The ladder is **monotonic for read within a tenant** (Tenant Admin ⊇ Manager ⊇ Rep) but **breaks at
the tenant edge**: no role reads across tenants except Platform Admin, and even then **aggregate by
default, audited break-glass for contents** (D2, §7). Secrets sit **outside** the ladder entirely —
**no rung reads them** (D7).

---

## 6. Role × capability matrix

Rows = capabilities; columns = the four roles. Cell legend: **✓** = full within scope · **own** =
owner-scoped only (D8) · **team** = workspace/team scope · **agg** = cross-tenant **aggregate** only
(no row-level/PII) · **—** = not permitted. (`viewer` = Rep column, read-only, no write/send/enroll.)

| Capability (`email.*`) | Rep | Manager | Tenant Admin | Platform Admin |
|---|---|---|---|---|
| Template create / edit (`template.create`/`.edit`) | own | team | team | — (agg view only) |
| Template share (`template.share`) | own | team | team | — |
| Template delete (`template.delete`) | own | team | team | — |
| Template publish to workspace (`template.publish`) | — | ✓ | ✓ | — |
| Sequence create / edit (`sequence.create`/`.edit`) | own | team | team | — |
| Enroll prospect (`sequence.enroll`) | own | team | team | — |
| Pause / stop sequence (`sequence.pause`/`.stop`) | own | team | team | — |
| Send email (`send`) — D4 gate + D5 idempotent | own | team | team | — |
| Connect mailbox (`mailbox.connect`) | own | own | ✓ (tenant) | — |
| Manage mailbox caps/disconnect (`mailbox.manage`) | own | team | ✓ (tenant) | — |
| Read mailbox/provider **secret** (D7) | — | — | — | — |
| Manage sending domain + tracking domain (`domain.manage`, D3) | — | — | ✓ | — |
| Manage reputation pool (`reputation.manage`, D2) | — | — | ✓ (own tenant) | ✓ (cross-tenant) |
| Manage warmup (`warmup.manage`) | — | — | ✓ (own tenant) | ✓ (infra) |
| View suppression (`suppression.view`) | own (how it gates me) | team | ✓ (tenant) | agg (counts) |
| Manage suppression (`suppression.manage`, D4) | — | — | ✓ (tenant/ws) | ✓ (global DNC) |
| View / manage consent (`consent.view`/`.manage`, D9) | view-own | view-team | ✓ manage | agg |
| View deliverability (`deliverability.view`) | own | team | ✓ (tenant) | agg (rates/DLQ) |
| Analytics — own (`analytics.own`) | ✓ | ✓ | ✓ | — |
| Analytics — team (`analytics.team`) | — | ✓ | ✓ | — |
| Analytics — workspace/tenant (`analytics.workspace`) | — | — | ✓ | — |
| Transfer ownership of email object (privileged + audited, §4) | — | team | ✓ (tenant) | via break-glass only |
| Manage hybrid provider / pool topology (`admin.provider`, D1) | — | — | — | ✓ |
| Manage email feature flags / rollout (`admin.flags`) | — | — | — | ✓ |
| Break-glass impersonation into a tenant (`admin.impersonate`) | — | — | — | ✓ (super_admin/support, audited) |

> **Reading the matrix.** Every non-`—` cell is *still* subject to the **two-check rule** (§4): the
> column proves the caller *may* hold the capability; the cell qualifier (own/team/✓/agg) is the
> **data-scope** that Check 2 enforces at the DB. The matrix is the function-level half; RLS +
> ownership is the object-level half. Neither alone is the boundary.

---

## 7. Break-glass / impersonation by Platform Admin

The **only** path for a Platform Admin to reach one tenant's email **contents** (a recipient list, a
message body, a specific `email_send`'s detail to reproduce a deliverability bug) is a **time-boxed,
reason-gated, customer-visible break-glass impersonation** — the same control the list plan defines
(`../list-plan/07 §4`), reused verbatim for email. The default platform path is **aggregate-only**
(§1, §6); break-glass is the rare, justified, bounded, observed exception.

**Properties (reuse the existing machinery — `impersonationSessions`, `withPlatformTx` audit):**
- **Role-gated:** only `super_admin` or `support` may start one (`email.admin.impersonate`,
  `requireStaffRole("super_admin","support")`); `billing_ops`/`compliance_officer`/`read_only`
  **cannot** enter a tenant's email context.
- **Reason mandatory:** a written justification is required and recorded on the session row + the
  audit row.
- **Time-boxed:** a hard `expires_at` bounds the window; the session carries **no secret/token
  material** — it is the *record of consent*, not a credential, and it never exposes mailbox/provider
  secrets (D7).
- **Read-only-first:** the session defaults to **read-only** of email contents. Any **write** as the
  tenant (sending, enrolling, editing a template, changing a domain) requires an explicit,
  separately-audited **step-up** — never an implicit consequence of "being in" the tenant.
- **Audited start + end + every action:** start/end and each email action under the session write an
  **append-only** `platform_audit_log` row (`admin.impersonate.start`/`.end`, plus email-aware
  actions — see below) in the **same transaction**, naming target tenant/workspace/user + reason.
- **Customer-visible:** when a session touches email contents, a **customer-visible** access-log row
  is mirrored into the tenant's own activity feed (actor = TruePoint Support, the object, the reason,
  the time), so trust is **verifiable, not promised** (mirrors `../list-plan/07 §5`).

**Email-aware audit action vocabulary (to define — emitted inside an impersonation session):**
`admin.email.view_send` (a specific message), `admin.email.view_sequence`,
`admin.email.action_as_tenant` (a write step-up), `admin.email.suppression_admin`,
`admin.email.reputation_admin`. Aggregate/infra reads (pool health, DLQ, rate rollups) need **no**
session and emit a lighter `admin.email.view_aggregate`.

This is the **list-plan governance pattern** applied to email: default deny-all to record-level
content, the single narrow break-glass exception, four-eyes for content access as the upgrade
target, and an immutable, customer-visible trail.

---

## 8. Phasing, surfaces, and the cross-tenant isolation test

**Phase wiring (PHASE MAP — owned by `13-rollout-phases.md`; do not invent phases):**
- **P0 — define the permission set.** The `email.*` enum lands in `@leadwolf/types`; the role→tier
  mapping (§2) and the two-check helpers in `packages/core/src/email/` are specified. No surface yet.
- **P1 → P5 — enforce alongside each web surface (`10-web-surface.md`).** Each web tab (templates,
  sequences, sends, mailboxes, analytics) ships with its `email.*` checks **and** its data-scope
  enforcement wired from the first endpoint. Permissions are **defined at P0, enforced from P1.**
- **P6 — admin surface (`11-admin-surface.md`).** The `email.admin.*` permissions, the
  `platformAdmin`+`requireStaffRole` gates, the aggregate-only platform analytics, and break-glass
  (§7) land with the admin surface.

**Surfaces this doc governs:**
- `10-web-surface.md` — the customer tabs (Rep/Manager/Tenant-Admin views) render **only** what the
  matrix permits; the role gates the navigation, the two-check rule gates the data.
- `11-admin-surface.md` — the platform-admin surface renders **aggregates** by default and exposes
  the break-glass flow (§7) as the controlled path to contents.

**The isolation test (known gap — must close).** TruePoint's constraints digest names a **real gap:
no per-endpoint cross-tenant HTTP isolation test exists**. This doc's boundaries are only *claims*
until that test proves them. **Required at P1 and extended through P6:** an integration test
(`packages/db/test` + `apps/api`) that, for **every** email endpoint, asserts:
1. a Rep cannot read/act on another Rep's email object → **404** (D8 + IDOR→404);
2. a caller in tenant A cannot read/act on any object in tenant B → **404** (no cross-tenant leak);
3. a client-supplied foreign ID (template/sequence/mailbox/domain) never resolves in scope;
4. no role's response ever contains a **raw secret** (D7);
5. every platform-admin row-level email access is **refused without an impersonation session**, and
   the session **writes an audit row** (§7).
Green on all five is the **done-when** for this doc's guarantees — the test, not the prose, is the
proof.

> **Other named gaps that touch this doc:** KMS is not yet done (D7 is enforced by server-side custody
> + no-secret-in-response today; KMS hardens it); per-tenant quota gates are unwired (the D10 fan-out
> caps that Tenant-Admin sets need the quota mechanism); a leader-locked scheduler must be confirmed
> for the sequence engine. None of these license skipping a permission or scope check — they are work
> to do, not exceptions to the rule.

---

## 9. Cross-references

- **`00-overview.md`** — D1 (hybrid provider), **D2 (reputation isolation per-tenant)**, D3 (custom
  tracking domain), D4 (suppression gates every send), D5 (idempotent sends), D6 (opens
  informational), **D7 (secrets server-side — no role sees them)**, **D8 (owner-scoped visibility —
  this doc realizes it)**, D9 (compliance), D10 (queue-backed fan-out); shared vocabulary.
- **`08-reporting-analytics.md`** — the own/team/workspace analytics scoping that
  `email.analytics.own/.team/.workspace` ties to; D6 (opens not a KPI) surfaces here.
- **`09-data-model.md`** — canonical entities, `owner_user_id`/`workspace_id`/`tenant_id` columns,
  the explicit-share model, references-not-copies, ownership-transfer semantics (§4/§5).
- **`10-web-surface.md`** — the customer tabs (Rep/Manager/Tenant-Admin) governed by the matrix (§6),
  wired P1–P5.
- **`11-admin-surface.md`** — the platform-admin surface, aggregate-only default, break-glass flow
  (§7), wired P6.
- **`13-rollout-phases.md`** — the authoritative PHASE MAP (P0 define, P1 enforce, P6 admin);
  reference, do not redefine.
- **`../list-plan/07-admin-staff-governance.md`** — the governance pattern this doc mirrors
  (break-glass, append-only audit, customer-visible access, staff role tiers).
- **TruePoint code** — `apps/api/.../middleware/requireRole.ts` / `requireOrgRole.ts` /
  `platformAdmin.ts` / `requireStaffRole.ts`; `packages/db` RLS; `packages/core/src/email/`
  (permission + ownership checks); `@leadwolf/types` (the `email.*` enum, `WorkspaceRole`/`OrgRole`/
  `StaffRole`).

---

### Sources (industry claims only)

- **Outreach**, *Admin & Roles / Visibility settings* — role- and team-scoped visibility configured
  by admins (§1).
- **Salesloft**, *Roles & Permissions* — rep/manager/admin tiers; managers gain team-level reporting,
  admins gain org-wide configuration (§1).
- **HubSpot**, *User Permissions / Sales Hub* — per-user permissions with "Everything / Team only /
  Owned only" data scopes (§1).
