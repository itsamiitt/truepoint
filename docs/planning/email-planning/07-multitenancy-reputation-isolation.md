# Email — Multi-Tenancy & Sending-Reputation Isolation at Scale (07)

> **Status:** Plan (not yet built). **Owner:** Platform + Security (Security has final say on the
> isolation boundary; Platform owns the tenancy mechanism and scale). **Last updated:** 2026-06-24.
> This is the **platform-risk document** of the email set: it answers one question precisely —
> **how does one tenant's sending behaviour stay entirely contained from every other tenant's, at
> scale?** It is the direct realization of **Decision D2** (`00-overview.md §3`): *reputation
> isolation IS per-tenant.* It cites the Locked Decisions (D1–D10) and Shared Vocabulary in
> `00-overview.md` verbatim, the entity ownership in `09-data-model.md`, the send/infrastructure
> mechanics in `02-sending-infrastructure.md` (D2's detailed home — referenced, not re-derived),
> the analytics scoping in `08-reporting-analytics.md`, the deliverability/warmup machinery in
> `03-deliverability.md`, the compliance gates in `06-compliance.md`, and the phase contract in
> `13-rollout-phases.md` (**this document's core lands in Phase P1**).
>
> **Precedence (root `CLAUDE.md`):** Security has the final say on whether an isolation claim is
> safe; **Platform owns the tenancy mechanism (RLS), the API contract, and scale**; Data owns the
> model; Design owns the UI. Every isolation guarantee below is enforced at the **database (RLS
> `ENABLE` + `FORCE`, fail-closed)** and in the **queue throttle**, never in the UI.

---

## 1. The principle (D2): reputation is a per-tenant asset, never a shared one

A tenant's **sending reputation** — the trust mail providers (Gmail, Yahoo, Microsoft) place in the
domains and IPs it sends from — is **its own asset, isolated by construction**. Per **D2** every
tenant sends from **its own authenticated `sending_domain` (a subdomain it controls) + its own
`mailbox_integration` pool (+ optional dedicated IP)**, and **no `sending_domain` is ever shared
across tenants**. The locked consequence: **one tenant's spam complaints, bounces, or blocklisting
never touch another tenant's reputation.**

We call this unit the **Reputation Pool** (shared vocabulary): *per-tenant sending domain + mailbox
set (+ optional dedicated IP)*. The Reputation Pool is the blast-radius boundary for everything in
this document.

This is the same stance the strongest 2024–2026 senders take. AWS's own multi-tenant guidance is
explicit: each tenant gets *"their own dedicated set of resources such as email sending IPs, domain,
and identifiers in DomainKeys Identified Mail (DKIM) signed headers,"* so that *"one tenant's actions
cannot affect the reputation or performance of other tenants"* and *"when a tenant experiences
delivery issues or reputation problems, these challenges remain contained within their dedicated
resources"* [1]. Smartlead frames the same idea for agencies — each client in *"their own Isolated
Cube with separate server environment, separate IPs, separate reputation, so one client's campaign
cannot touch another's deliverability"* [4][5]. Instantly's multi-client playbook: *"isolates clients
by assigning each a dedicated IP pool and subdomain tree so a temporary dip on one brand does not
spread"* [2][3].

> The control is **structural**, not behavioural: it holds even when a tenant misbehaves, because
> there is no shared surface to poison. This mirrors the List tab's stance that isolation is a
> technical boundary, not a promise (`list-plan/08 §1`).

---

## 2. The failure mode this prevents — shared-reputation poisoning

The architecture exists to defeat one specific, well-understood failure. **Shared-reputation
poisoning** is what happens when many tenants send from a *common* domain or IP pool:

1. **Mailbox providers rate the shared identity, not the tenant.** Gmail/Yahoo build reputation per
   *sending domain* and per *IP*. They cannot see "tenant" — only the `From` domain and the
   connecting IP. If those are shared, the **rating is shared**.
2. **One bad actor's complaints become everyone's ceiling.** The 2024 Gmail/Yahoo bulk-sender rules
   set a **hard spam-complaint ceiling of 0.3%** (enforcement began Feb 2024 and **escalated from
   temporary delays to permanent rejections in November 2025**), with **0.1% as the recommended
   target** — *"the 0.3% threshold is when enforcement begins, not a safe target"* [6][9]. On a
   **shared** domain/IP, a single tenant driving complaints toward 0.3% pushes the *whole shared
   identity* past the ceiling. Every co-resident tenant — including the careful ones — starts landing
   in spam.
3. **Blocklisting is collective.** A Spamhaus listing or a provider block attaches to the **IP/domain**.
   On shared infrastructure, the innocent are blocked alongside the guilty (AWS monitors *"Spamhaus IP
   listing status"* per tenant precisely so a listing is contained [1]).
4. **Recovery is slow and shared.** Reputation damage at 0.3%+ complaints *"takes weeks to months"* to
   recover [11], and on shared infrastructure no individual tenant can recover faster than the worst
   co-tenant allows.

**Why per-tenant isolation defeats it:** because the `sending_domain` and IP that providers rate are
**unique to the tenant**, a tenant's complaint rate is computed against *its own* sends only. Its
0.3% breach degrades *its own* inbox placement and nobody else's; its blocklisting lists *its own*
identity; its recovery is *its own* problem. The ceiling is **per-tenant by construction** — which is
exactly the property D2 locks.

---

## 3. Per-tenant mailbox isolation (each tenant's mailboxes are theirs)

A `mailbox_integration` (a connected Gmail/Microsoft 365/SMTP sender, or a TruePoint-provisioned
mailbox) **belongs to exactly one tenant**, and is reachable only within that tenant's RLS context.

- **Schema (owned by `09-data-model.md`).** `mailbox_integration` carries `tenant_id` always and
  `workspace_id` where workspace-scoped (mailboxes are workspace-scoped; a sending mailbox lives in
  one workspace), plus `owner_user_id` for owner-scoped visibility (D8). Indexes are **`tenant_id`-leading**
  (TruePoint tenancy rule).
- **No cross-tenant mailbox access.** `mailbox_integration` is **`ENABLE` + `FORCE` RLS**, two-tier
  scoped on `app.current_workspace_id` with the **fail-closed `NULLIF` idiom** — an unset or `''`-reset
  GUC yields `NULL`, the predicate matches nothing, and an unscoped read **returns zero rows** rather
  than leaking (the same pattern proven for `lists`/`list_members` in `list-plan/08 §1.2`). This is
  defence-in-depth: the repository/core layer also filters by tenant/workspace, but RLS is the wall.
- **Secrets never on the client (D7).** OAuth tokens / SMTP credentials for a mailbox are stored
  **server-side, KMS-wrapped** (envelope encryption is the target; **KMS is a carried gap — see §11**).
  No mailbox credential is ever returned to `apps/web`; reveal/use happens only inside the send path
  (`apps/api` / `apps/workers`).
- **IDOR → 404 (Security).** A mailbox id supplied by the client is **never trusted**; a request for a
  mailbox outside the caller's tenant/workspace resolves to **404**, not 403 (no existence oracle).
- **BYO-mailbox is the dominant industry model and reinforces isolation.** Salesloft/Outreach connect
  to the customer's *own* Google Workspace / Microsoft 365 and send *as that customer's mailbox* —
  *"individually schedule emails to be sent inside your email client on your behalf"* [13][14]. The
  customer's mailboxes are inherently theirs; TruePoint's hybrid provider strategy (**D1**) preserves
  this — BYO mailboxes plus, optionally, TruePoint-provisioned pools, all tenant-scoped.

This extends the existing two-tier RLS tenancy (`tenant_id`/`workspace_id`) to the mailbox layer
unchanged: a mailbox is just another tenant-owned record, isolated the same way contacts and lists are.

---

## 4. Per-tenant sending reputation (D2) — the Reputation Pool

Each tenant's reputation is anchored in **its own `sending_domain`** — an authenticated subdomain it
controls (e.g. `mail.acme-tenant.example`) — paired with **its own mailbox pool** and, for high/steady
volume, an **optional dedicated IP**. The mechanics (warmup ramp, authentication, IP assignment) are
detailed by **D2 in `02-sending-infrastructure.md` and `03-deliverability.md`** — this section states
the *isolation contract* only.

### 4.1 The sending domain is per-tenant, authenticated, and never shared

- `sending_domain` carries `tenant_id` always (a sending domain is a tenant-level reputation asset;
  it may be usable across the tenant's workspaces, but **never across tenants**), under `ENABLE` +
  `FORCE` RLS, `NULLIF` fail-closed, `tenant_id`-leading indexes (`09-data-model.md`).
- **Each `sending_domain` has its own SPF, DKIM, and DMARC.** Per-subdomain authentication is what lets
  providers build a *distinct* reputation profile: *"Subdomains operate with independent email
  authentication. Each requires its own SPF, DKIM, and DMARC records … Each subdomain requires its own
  DKIM key pair. You cannot reuse your main domain's DKIM signature"* [10]. TruePoint provisions and
  verifies these per `sending_domain` (mechanics in `02`).
- **Subdomain, not root.** Using a subdomain (or a separate cold-outreach domain) **protects the
  tenant's primary brand domain**: *"each subdomain you create has its own reputation, adding a layer
  of protection for your root domain"* [3]; *"send from subdomains that leverage your root domain's
  reputation while containing all risk"* [4]. Isolation is **partial for subdomains** (they inherit
  some parent trust) and **complete for fully separate domains** which *"share zero reputation with
  your primary domain"* [10] — TruePoint supports both, the choice surfaced per tenant in the admin
  surface (`11-admin-surface.md`).

### 4.2 The mailbox pool + inbox rotation

A tenant's send volume is spread across **its own pool of mailboxes** with rotation, so no single
mailbox over-sends — the standard practice: *"automatic mailbox rotation across multiple sending
addresses, distributing volume to maintain individual mailbox health"* [12], and Instantly's guidance
to *"connect two to six inboxes per client … enable warmup on each"* [2]. The **per-mailbox and
per-tenant throttles live in the queue (D10)** — see §6. Warmup runs per mailbox/domain
(`03-deliverability.md`).

### 4.3 Optional dedicated IP

For tenants with **high and consistent** volume, a **dedicated IP** removes even the shared-IP-pool
risk. Industry guidance ties the dedicated IP to volume/consistency, not a hard floor — *"use
dedicated IPs when sending is both high and consistent over time"* [8]; AWS sizes pools at *"one IP
per 50,000 daily emails"* [1]. Below that, a tenant rides a **shared, warmed IP pool** (still on its
own per-tenant *domain*, so domain-reputation isolation holds). The dedicated-IP decision is a
per-tenant FinOps + deliverability tradeoff surfaced in `11-admin-surface.md` and detailed in `02`.

### 4.4 Per-tenant tracking domain (D3)

Open/click tracking links use a **custom tracking domain per tenant** (D3), never a TruePoint-shared
tracking host. Shared tracking domains hurt deliverability and leak a cross-tenant signal; a custom
per-tenant tracking domain *"can greatly reduce the likelihood of emails landing in spam"* and aligns
the tracked link with the sender [14]. The tracking domain is a per-tenant reputation surface owned
alongside `sending_domain`; tracking-event handling is in `04-status-event-tracking.md` and analytics
in `08-reporting-analytics.md`.

---

## 5. Tenant-scoped suppression lists (D4)

A tenant's **`suppression_list`** rows are its own. Per **D4**, suppression **gates every send,
fail-closed, tenant- and workspace-scoped** — and a suppression **never leaks to or from another
tenant**.

- **Scope.** `suppression_list` carries `tenant_id` always; scope is `tenant` or `workspace` for
  tenant-owned suppressions (a tenant's hard bounces, complaints, unsubscribes). A **`global` scope**
  exists for platform-level regulatory suppression (a DSAR erasure / Do-Not-Contact that must block
  *every* tenant) — this is the **one deliberate exception** and it only ever *adds* a block, never
  reveals one tenant's list to another. (Mirrors the List tab's `{global, tenant, workspace}` model,
  `list-plan/08 §6`.)
- **Isolation.** `suppression_list` is `ENABLE` + `FORCE` RLS, `NULLIF` fail-closed, `tenant_id`-leading
  index. A tenant querying or matching suppressions sees only its own (`tenant`/`workspace`) rows plus
  the `global` set — it can **never enumerate another tenant's suppressions**, and its suppressions are
  **never visible to another tenant**.
- **Fail-closed gate (D4).** The suppression check runs **inside the send transaction** (not as a
  bypassable pre-guard): no outbound send (an `outreach_log` advance recorded in `activities`) is
  dispatched without consulting suppression in-tx, and an
  unscoped/missing context fails the check **closed** (blocks the send). Matching is by **blind index**
  (HMAC of normalized email/domain), never plaintext — the same unbypassable pattern as the List tab's
  `assertNotSuppressed` (`list-plan/08 §6`). Compliance semantics (consent, opt-out → suppression) are
  owned by `06-compliance.md`.
- **A complaint or hard bounce auto-suppresses — within the tenant.** When a tenant's send draws a
  spam complaint (feedback loop) or hard bounce, the address is written to **that tenant's**
  `suppression_list`. The signal also feeds the per-tenant circuit breaker (§6) — but the suppression
  row itself stays tenant-scoped.

---

## 6. Containing a noisy or abusive tenant

Isolation prevents *cross*-tenant harm; containment limits a tenant's *self*-harm and protects shared
upstream resources (the ESP account, shared warmed IP pools). All controls are **per-tenant** and built
on TruePoint's existing tenancy + queue + FinOps machinery.

### 6.1 Per-tenant throttles (queue-enforced, D10)

Fan-out and ingestion are **queue-backed with per-tenant and per-mailbox throttling in-queue** (D10).
Backpressure bounds the fan-out (TruePoint queue rule). The throttles enforce:

- **Per-tenant send rate** (sends/minute/hour) and **per-mailbox rate** (so no mailbox over-sends —
  Instantly's ramp caps to *"30 sends per inbox per day"* during warmup [3]).
- **Per-user limit** on metered sends (Operations rule: *per-tenant FinOps quota + hard cap +
  per-user limit*).

These are not UI niceties — they are enforced where the work happens, in `apps/workers/src/queues/email*.ts`.

### 6.2 Complaint-rate circuit breaker (the auto-pause)

The headline containment control: **a per-tenant circuit breaker that automatically pauses a tenant's
sends when its complaint rate (or bounce rate) breaches a threshold.** This is the exact mechanism the
strongest multi-tenant senders ship — AWS *"can automatically pause sending for the affected tenant
while allowing other tenants to continue their email operations unimpeded,"* driven by **per-tenant
reputation policies** (a **standard** policy *"pausing on high severity findings"* and a **strict**
policy *"pausing on low severity findings"*), monitoring *"complaint rates per tenant,"* *"third-party
specific complaint rates,"* *"Spamhaus IP listing status,"* and *"email volume pattern"* [1].

TruePoint's circuit breaker, as a **per-tenant control** in `packages/core/src/email/`:

| Parameter | Value (initial) | Source / rationale |
|---|---|---|
| **Complaint-rate trip threshold** | **0.3% hard ceiling** (auto-pause), **0.1% warn** | Gmail/Yahoo bulk-sender rule: 0.3% enforced, 0.1% target [6][9]; AWS strict policy uses **0.1%** complaint [1] |
| **Hard-bounce trip threshold** | **≤2% warn, escalate above** | Smartlead *"keep bounce rates under 2%"* [12]; Instantly *"at or below 1%"* [3]; AWS bounce threshold **5%** [1] |
| **Measurement window** | rolling per-tenant over recent sends (min volume floor) | rate is meaningless on tiny volume; compute per Reputation Pool |
| **Action on trip** | **auto-pause the tenant's sends** (enqueue → hold), alert, require review to resume | AWS auto-pause [1]; per-tenant so others are *"unimpeded"* |
| **Scope of pause** | the tripping **tenant only** (optionally narrowable to a `sending_domain`/pool) | blast radius = the Reputation Pool |

The breaker reads **per-tenant analytics** (complaint/bounce/volume counts — cross-ref
`08-reporting-analytics.md §[tenant-scoped metrics]`), trips per the table, and **pauses only the
offending tenant**. Complaint-rate alerting is an Operations SLO (Operations: *complaint-rate
alerting*). Resume is a governed admin action (`11`, `12-roles-permissions.md`), audited (IDs + action,
no PII).

### 6.3 IP-pool isolation

- A tenant on a **dedicated IP** (§4.3) is fully IP-isolated: its blocklisting/complaints attach to
  *its* IP only — the Smartlead/Instantly "separate IPs, separate reputation" model [2][4].
- A tenant on a **shared warmed pool** still has **per-tenant domain isolation**, and the circuit
  breaker (§6.2) protects co-tenants on that pool by pausing the offender **before** its complaints
  can degrade the shared IP. AWS's per-tenant Spamhaus monitoring [1] is the pattern: detect and pause
  before a shared resource is listed.
- **Pool cap is a real constraint.** AWS allows *"no more than 50 dedicated IP pools per AWS Region"*
  and up to *"10,000 isolated tenants within a single AWS account"* (raisable to 300,000) [1] — i.e.
  **not every tenant can have a dedicated IP**; dedicated IPs are a per-tenant entitlement (FinOps
  tradeoff, §6.5), and the default is a shared-but-warmed pool with the breaker as the guard.

### 6.4 Quarantine

On **confirmed abuse** (not just a rate blip), a platform-admin can **quarantine** a tenant's sending:
a status flag on the tenant's Reputation Pool that **disables new sends** (and, optionally, pauses
warmup) while leaving data intact and the tenant notified. Quarantine acts on the **container's
status**, needs no PII read, is **audited** (IDs + action), and is lifted by a governed admin action.
This mirrors the List tab's container-level quarantine on abuse (`list-plan/07 §6`). Cross-tenant
quarantine is reachable **only via the audited platform-admin role** (TruePoint tenancy rule), never a
normal tenant request.

### 6.5 Per-tenant FinOps quota + hard cap (Operations)

Email is a **metered** path; the Operations mandate is **per-tenant FinOps quota + hard cap +
per-user limit**. A tenant cannot exceed its provisioned send volume; the hard cap is a backstop that
also limits abuse-driven cost and complaint exposure. **Known gap (carry as mandate, §11):
per-tenant quota gates are currently UNWIRED into metered paths — they MUST be wired before metered
email ships** (`13-rollout-phases.md` P1/P6).

---

## 7. Tenant-scoped analytics (cross-ref 08)

Reputation decisions depend on metrics, and **every metric is tenant-scoped** (full design in
`08-reporting-analytics.md`):

- Sends, deliveries, hard/soft bounces, complaints, the derived **complaint rate** and **bounce rate**
  per `sending_domain`/Reputation Pool — all computed **within the tenant's RLS boundary**, never
  across tenants. A tenant can never see another tenant's deliverability numbers.
- The circuit breaker (§6.2) and the admin reputation dashboard (`11`) consume these tenant-scoped
  metrics; the breaker's threshold check is just a per-tenant query over them.
- **Opens are informational, not a KPI (D6).** Reputation health keys off **complaints and bounces**
  (provider-enforced signals), not opens. Aggregate, count-based metrics only — no cross-tenant PII
  joins, mirroring the List tab's aggregate-only analytics stance (`list-plan/07 §7`).

---

## 8. Architecture options — the tradeoffs table

Three ways to host multi-tenant sending. TruePoint's choice (**D1 hybrid**) is option **B**, with
option **C** as the entitlement for the largest tenants and the residency mandate (§11).

| Dimension | **A. Shared ESP account, per-tenant subdomains + pools** | **B. Hybrid — shared account, per-tenant domain/pool, dedicated IP & cluster as entitlement** *(TruePoint, D1)* | **C. Fully dedicated infra per tenant** |
|---|---|---|---|
| **Reputation isolation** | Per *domain* (good): each tenant on own `sending_domain` → domain-rep isolated. Shared IP pool → residual IP-rep coupling, guarded by breaker | **Strong**: per-tenant domain always; dedicated IP for high-volume/sensitive tenants → full IP isolation where it matters | **Maximal**: separate domain *and* IP *and* account/cluster per tenant — zero shared surface |
| **Blast radius of a bad tenant** | Domain-bounded; shared IP/account is residual risk (breaker + Spamhaus-monitor must catch it [1]) | Domain-bounded by default; IP-bounded for dedicated tenants; breaker pauses offenders before shared-IP harm | None — fully contained |
| **Cost / FinOps** | **Lowest** — one account, shared IPs amortized | **Moderate** — shared baseline; pay for dedicated IPs/clusters only where earned (per-tenant quota + cap) | **Highest** — per-tenant account/IP/cluster overhead; doesn't amortize |
| **Operational complexity** | Low — one account to operate, one warmup fleet | **Moderate** — tiered: most tenants simple, a few dedicated; one control plane (breaker, quotas) spans all | High — N accounts/clusters to provision, warm, monitor, patch |
| **Scale ceiling** | ESP account/IP-pool caps bite (AWS: **50 IP pools/region**, **10k tenants/account** raisable to 300k [1]) | Same caps, but dedicated IPs rationed to those who need them → scales to many tenants on shared+warmed pools | Bounded by per-tenant provisioning cost; hardest to scale to many small tenants |
| **Data residency / EU siloing** | Hard — shared account spans regions | **Partial** — region tags exist; **true EU siloing not yet built (§11 mandate)**; dedicated cluster is the path | **Native** — a tenant's cluster can live entirely in-region |
| **Time to onboard a tenant** | **Fastest** — provision a subdomain + mailboxes | **Fast for standard; slower for dedicated** (IP warmup is *"weeks, not days"* [8]) | **Slowest** — stand up and warm whole infra |
| **Maps to** | Smartlead/Instantly *shared-pool* tier [2][4]; AWS single-account multi-tenant [1] | AWS **tenant management** (per-tenant policy + IP pool + auto-pause) [1]; Smartlead SmartServers tier [5]; Instantly dedicated-pool tier [2] | Smartlead "Isolated Cube" / SmartInfra privatised [4][5]; per-client dedicated servers |

**Why B (hybrid).** It gives every tenant the property D2 requires — **per-tenant domain reputation
isolation, by default, for free** — while spending dedicated IPs/clusters only where volume,
sensitivity, or residency earns them. It rides one control plane (one circuit breaker, one quota
system, one warmup fleet) so operability stays sane, and it leaves a clean upgrade path to **C** for
the largest/most-regulated tenants. This is precisely the AWS tenant-management posture [1] and the
tiered Smartlead/Instantly model [2][4][5].

---

## 9. Mapping to TruePoint — extending two-tier RLS to the reputation layer

The reputation layer is **not a new tenancy model** — it is the existing two-tier RLS tenancy
(`tenant_id`/`workspace_id`) extended to two new reputation-bearing entities.

- **Entities (owned by `09-data-model.md`):** `sending_domain` (`tenant_id`-scoped reputation asset)
  and `mailbox_integration` (`tenant_id` + `workspace_id`, `owner_user_id` for D8) are **per-tenant**.
  Every email entity carries `tenant_id` always, `workspace_id` where workspace-scoped, `owner_user_id`
  where user-owned.
- **RLS, fail-closed.** Both tables (and `suppression_list`, `outreach_log`, `activities` / `email_event`) are
  **`ENABLE` + `FORCE` ROW LEVEL SECURITY**, two-tier on the `app.current_tenant_id` /
  `app.current_workspace_id` GUCs set **`LOCAL`** per transaction (`withTenantTx`), with the fail-closed
  **`NULLIF(current_setting(…, true), '')`** idiom so an unset GUC reads/writes **nothing**. Policies
  and `tenant_id`-leading indexes land in `packages/db/src/rls/email.sql` and
  `packages/db/src/schema/email.ts`; repository access goes through `packages/db/src/repositories/emailRepository.ts`.
  Workers **set tenant context per job**; cross-tenant ops (quarantine, global suppression) run only
  through the **audited platform-admin role**.
- **Reputation + breaker logic** lives in `packages/core/src/email/` (per-tenant reputation evaluation
  + complaint-rate circuit breaker); the **per-tenant/per-mailbox throttles** and fan-out live in
  `apps/workers/src/queues/email*.ts`; the **per-tenant reputation controls** (thresholds, dedicated-IP
  entitlement, quarantine, resume) are admin routes under `apps/api/src/features/admin/`, governed by
  `12-roles-permissions.md`.
- **API contract.** `/api/v1`, Zod schemas in `@leadwolf/types`, cursor pagination, `Idempotency-Key`
  (sends are idempotent, D5), RFC 9457 error envelope, rate limits. A tenant/mailbox/domain id from the
  client is **never trusted**; out-of-tenant access resolves **404** (Security, IDOR → 404).

---

## 10. Self-test — the isolation proofs that must pass

These are the executable proofs of this document's guarantees (run in `packages/db/test`, modelled on
the List tab's isolation itests, `list-plan/08 §9`; gated per phase in `13-rollout-phases.md`):

| # | Test | Asserts | Phase |
|---|---|---|---|
| 1 | **Mailbox/domain isolation** | Two tenants × workspaces; reads/writes of `mailbox_integration` and `sending_domain` **never cross** `app.current_tenant_id`/`app.current_workspace_id`; an **unscoped** (GUC unset) read returns **zero rows** (`NULLIF` fail-closed). **0 cross-tenant leaks.** | P1 |
| 2 | **Suppression isolation + fail-closed gate** | A tenant's `suppression_list` rows are invisible to another tenant; a `global` row blocks **every** tenant; the in-tx suppression gate **blocks a send** when context is unset (fail-closed, D4); matching is by blind index, never plaintext. | P1 |
| 3 | **Circuit-breaker containment** | A tenant breaching the **0.3%** complaint ceiling is **auto-paused**; a *co-tenant on the same shared pool keeps sending* (unimpeded); resume is a governed, audited admin action. | P1/P5 |
| 4 | **Cross-tenant HTTP isolation (per-endpoint)** | Every email endpoint rejects an out-of-tenant `sending_domain`/`mailbox_integration`/suppression id with **404**, never returning another tenant's data. **This per-endpoint cross-tenant HTTP isolation test is a CARRIED GAP (§11) and MUST be added before shipping.** | P1 |
| 5 | **Quota gate on metered send** | A tenant at its hard cap cannot send; the per-tenant FinOps quota is consulted in the metered path. **Wiring the quota into metered email is a CARRIED GAP (§11).** | P1/P6 |

---

## 11. Carried gaps (mandates, not licenses to skip)

Per the TruePoint constraints digest, these gaps are **mandates** — the target is the rule, the gap is
work to do before shipping:

1. **KMS not done (D7).** Mailbox credentials / DKIM private keys must be **KMS-wrapped, server-side**.
   Until KMS lands, secrets are still server-side and never on the client, but envelope encryption with
   rotation is a **mandate before metered/production email** (`02-sending-infrastructure.md`).
2. **No per-endpoint cross-tenant HTTP isolation test.** **ADD before shipping** (test #4, §10) — an
   itest proving every email endpoint 404s an out-of-tenant id.
3. **Per-tenant quota gates UNWIRED into metered paths.** Wire the per-tenant FinOps quota + hard cap +
   per-user limit into the metered send path **before metered email** (test #5, §10; Operations).
4. **Enterprise siloing / dedicated clusters NOT built.** Residency-constrained tenants **cannot be
   EU-siloed today**; region tags exist but true single-region siloing / dedicated clusters
   (architecture option **C**, §8) is the **enterprise-residency mandate** — the upgrade path is
   designed, not yet implemented.
5. **Confirm leader-locked scheduler.** The send scheduler / circuit-breaker evaluator must run under a
   confirmed **leader lock** so a tenant isn't double-paused or double-sent across worker replicas.

---

## 12. Cross-references

- **`00-overview.md §3`** — Locked Decisions **D1–D10** (canonical; **D2** is this doc's spine), Shared
  Vocabulary (Reputation Pool, Mailbox, Sending Domain, Suppression, Warmup).
- **`02-sending-infrastructure.md`** — **D2's detailed home**: per-tenant domain authentication
  (SPF/DKIM/DMARC), mailbox pool + rotation, IP assignment, warmup ramp. This doc states the isolation
  *contract*; `02` states the *mechanics*.
- **`03-deliverability.md`** — warmup, inbox-placement, the deliverability levers behind the breaker.
- **`04-status-event-tracking.md`** — complaint/bounce/feedback-loop ingestion feeding suppression + breaker.
- **`06-compliance.md`** — consent (`consent_records`), opt-out → suppression, the regulatory `global` suppression.
- **`08-reporting-analytics.md`** — tenant-scoped metrics the breaker and admin dashboard consume (§7).
- **`09-data-model.md`** — `sending_domain`, `mailbox_integration`, `suppression_list`, `outreach_log`,
  `activities` / `email_event` schema + RLS columns; the canonical entity owner.
- **`11-admin-surface.md`** — per-tenant reputation controls, dedicated-IP entitlement, quarantine, resume.
- **`12-roles-permissions.md`** — who may set thresholds, quarantine, resume; the audited platform-admin role.
- **`13-rollout-phases.md`** — **P1** (reputation isolation + send path — this doc's core), **P5**
  (analytics behind the breaker), **P6** (admin governance, per-tenant limits, global suppression).
- **`list-plan/08 §1`–`§9`, `list-plan/07 §6`–`§7`** — the proven two-tier RLS isolation, fail-closed
  `NULLIF`, container-quarantine, and aggregate-only analytics patterns this doc reuses.

---

## Sources

1. AWS Messaging & Targeting Blog — *Improve email deliverability with tenant management in Amazon SES* (per-tenant isolation, per-tenant IP pools, per-tenant reputation policies, auto-pause, complaint/bounce thresholds, pool & tenant limits). https://aws.amazon.com/blogs/messaging-and-targeting/improve-email-deliverability-with-tenant-management-in-amazon-ses/
2. Instantly — *Scale Client Leads: Instantly's deliverability & multi-account playbook* (per-client dedicated IP pool + subdomain tree, inboxes per client, warmup network). https://instantly.ai/blog/deliverability-multi-account-playbook/
3. Instantly — *Dedicated vs. Shared IP pools: Which is best for your cold outreach?* (per-client lanes, 0.3%/0.1% complaint, ≤1% bounce, 30 sends/inbox/day ramp, subdomain isolation). https://instantly.ai/blog/dedicated-vs-shared-ip-pools-for-cold-outreach/
4. Salesforge — *Smartlead Email Infrastructure Explained (Shared vs Dedicated Reality)* / Smartlead Isolated Cube & subdomain risk-containment. https://www.salesforge.ai/blog/smartlead-email-infrastructure
5. Smartlead — *SmartServers / SmartInfra: dedicated, privatised infrastructure that isolates your reputation*. https://www.smartlead.ai/dedicated-servers
6. Mailgun — *Yahoogle: New Bulk Sender Requirements in 2024* (0.3% hard / 0.1% target spam-complaint threshold, 5,000+/day). https://www.mailgun.com/state-of-email-deliverability/chapter/yahoogle-bulk-senders/
7. AWS Documentation — *Creating standard dedicated IP pools / Dedicated IP addresses for Amazon SES* (IP pool mechanics, per-region limits). https://docs.aws.amazon.com/ses/latest/dg/dedicated-ip-pools.html
8. Instantly — dedicated-IP volume/consistency guidance (*"high and consistent"*, warmup *"weeks, not days"*). https://instantly.ai/blog/dedicated-vs-shared-ip-pools-for-cold-outreach/
9. EmailWarmup — *Gmail and Yahoo Bulk Sender Requirements [Updated for 2026]* (0.3% enforcement, Nov 2025 escalation to permanent rejection). https://emailwarmup.com/blog/email-deliverability/gmail-and-yahoo-bulk-sender-requirements/
10. GrowLeads — *Subdomain for Cold Email: Protect Your Main Domain in 2026* (per-subdomain SPF/DKIM/DMARC, partial vs complete isolation, volume thresholds). https://growleads.io/blog/subdomain-for-cold-email-protect-main-domain/
11. Smartlead — *Email Deliverability Guide* (complaint-rate recovery timelines, bounce thresholds). https://www.smartlead.ai/blog/email-deliverability-guide
12. Smartlead — *Email Deliverability Guide* (mailbox rotation, <2% bounce, dedicated IPs per campaign). https://www.smartlead.ai/blog/email-deliverability-guide
13. Salesloft Help Center — *Setting Up Email Sending Domains / DKIM* and BYO Google Workspace / O365 sending model. https://help.salesloft.com/s/article/Setting-Up-Email-Sending-Domains-DKIM
14. Outreach Support — *SPF, DKIM, and DMARC Overview for Outreach Email Users* + custom tracking domain reduces spam-folder risk. https://support.outreach.io/hc/en-us/articles/115005650848-SPF-DKIM-and-DMARC-Overview-for-Outreach-Email-Users
