# Email — Admin Surface (`/admin`) Plan (11)

> **Status:** Plan (not yet built). **Owner:** Platform + Security. **Last updated:** 2026-06-24.
> This is the **Phase-2 plan for the internal `/admin` surface** of the email subsystem — the
> platform-admin / staff console in **`apps/admin`** (API in **`apps/api/src/features/admin/`**).
> It is the internal mirror of the customer-facing plan in `10-web-surface.md`: where `10` lays out
> what a *tenant* sees and does, this doc lays out what **TruePoint platform-admins** see and do
> **across** tenants. It cites the Locked Decisions (D1–D10) and the Shared Vocabulary in
> `00-overview.md`, the canonical entities in `09-data-model.md`, the deliverability monitoring in
> `03-deliverability.md`, the multitenancy/reputation isolation in `07-multitenancy-reputation-isolation.md`,
> the compliance mechanics in `06-compliance.md`, the role tiers in `12-roles-permissions.md`, and the
> phase contract in `13-rollout-phases.md` (this work is mainly **P6 Admin + governance**; deliverability
> monitoring tracks **P5**).
>
> **Precedence (root `CLAUDE.md`):** **Security has the final say on whether something is safe.**
> **Platform owns the tenancy mechanism (RLS), the API contract, and scale.** Every surface below is
> **platform-admin scoped — NEVER tenant-visible**. Every cross-tenant read or write goes through the
> **audited `leadwolf_admin` path** (`withPlatformTx`) and is **gated by the `platformAdmin`
> middleware + `requireStaffRole(...)`**. **Secrets are never rendered (D7).** Audit logs store
> **IDs + actions, never PII or message bodies.** This mirrors the shape of `list-plan/07-admin-staff-governance.md`.

---

## 1. Scope, principles, and what makes this surface "admin"

The email subsystem hands TruePoint a new class of cross-tenant operational responsibility: we are now a
**sender of record** on behalf of every tenant. A tenant's bad list, spam-trap hit, or complaint spike is
not just *their* problem — left unchecked it poisons shared infrastructure (an ESP sub-account, an IP pool,
a tracking domain CNAME). The `/admin` surface exists to give platform-admins the controls that modern
multi-tenant email platforms now ship as table stakes: **per-tenant reputation isolation with automated
auto-pause**, **tenant-level metrics**, and **tenant-scoped suppression** — the exact model AWS SES
formalized in its August 2025 *tenant isolation with automated reputation policies* release, where an admin
configures dedicated per-tenant identities, sees real-time per-tenant bounce/complaint rates, and SES "can
automatically pause the affected tenant to protect other email streams." ([AWS SES tenant isolation, Aug
2025](https://aws.amazon.com/about-aws/whats-new/2025/08/amazon-ses-tenant-isolation-automated-reputation-policies/);
[MailChannels multi-tenant deliverability, 2026](https://www.mailchannels.com/multi-tenant-email-deliverability/))

**Operating principles (inherited, not re-derived):**

- **Platform-admin scoped, never tenant-visible.** Nothing in this doc renders in `apps/web`. Every page
  lives in `apps/admin`; every endpoint sits behind `apps/api/src/features/admin/` under the existing
  `authn` + `platformAdmin` middleware chain (`routes.ts` already does `adminRoutes.use("*", platformAdmin)`),
  with finer **`requireStaffRole(...)`** gating per section (`12-roles-permissions.md`).
- **Cross-tenant access is the audited exception.** Admin reads/writes run through **`withPlatformTx`**
  (the `leadwolf_admin` owner-role RLS path), which writes a `platform_audit_log` row **in the same
  transaction** as the action and **bounds** every cross-tenant read (`PLATFORM_READ_LIMIT`). There are no
  unbounded cross-tenant scans. This is the highest-privilege surface in the API; **nothing reaches it
  without `pa === true`** (`routes.ts`).
- **No PII, no bodies, no secrets.** Per **D7**, admins never see raw ESP credentials/API keys (KMS-backed,
  server-side only). Per `06-compliance.md`, the audit viewer renders **IDs + actions only** — never a
  recipient address, never a rendered `email_send` body. Deliverability and usage analytics are
  **aggregate** (counts/rates), mirroring the privacy-first staff stance of `list-plan/07 §1`.
- **Four states + `@leadwolf/ui` + virtualization.** Every screen uses `StateSwitch` (loading / empty /
  error / data), `@leadwolf/ui` primitives, `var(--tp-*)` tokens, WCAG 2.2 AA, i18n, light theme only.
  Every large table (sends, suppression, audit, mailboxes across tenants) is **cursor-paginated + virtualized**.
- **Read-only-first; writes are step-up + audited.** Day-to-day operation is observation. A *mutation*
  (disconnect a tenant's mailbox, pause a tenant, edit a quota, add a global suppression) is a deliberate,
  separately-audited action gated to a senior staff role — the same break-glass discipline `list-plan/07 §4`
  applies to list contents.

> **The single narrow exception** to "admins never read tenant data" is the break-glass impersonation path
> (`list-plan/07 §4`, existing `impersonation.ts`). The email-admin surfaces below are designed so routine
> ops — deliverability triage, quota changes, suppression, billing — **never need** record-level access to a
> tenant's recipients or message bodies.

---

## 2. The admin section catalog (the contract)

Seven sections. Each is detailed in §3.1–§3.7. The table below is the authoritative index; **"Who can
access"** names the `requireStaffRole(...)` tiers from `12-roles-permissions.md` (recap: `super_admin`,
`support`, `billing_ops`, `compliance_officer`, `read_only` — all *behind* the coarse `platformAdmin` gate).

| § | Section | Purpose | Key elements | Primary actions | Who can access |
|---|---|---|---|---|---|
| 3.1 | **Tenant Mailbox & Domain** | View/connect/disconnect `mailbox_integration` per tenant; manage `sending_domain` SPF/DKIM/DMARC + custom tracking-domain (D3) CNAME; see verification state | Per-tenant mailbox list (provider, status, owner), domain DNS-auth panel (SPF/DKIM/DMARC pass/fail), tracking-domain CNAME status, verification badges | Re-trigger DNS recheck; disconnect a stuck mailbox; force re-verify domain; **never** view raw OAuth tokens/secrets (D7) | `super_admin`, `support` (act); `read_only`, `compliance_officer` (read) |
| 3.2 | **Sending-Infrastructure Config** | Configure the D1 hybrid provider strategy: ESP accounts, IP pools, warmup policy, provider routing | ESP-account registry (no secrets shown), IP-pool definitions (shared/dedicated), warmup-policy presets, per-tenant routing rules | Register/disable ESP account; assign IP pool; set warmup ramp; set routing override per tenant | `super_admin` only |
| 3.3 | **Deliverability Monitoring** | Per-tenant inbox-placement, blacklist, complaint rate, bounce rate (cross-ref `03`, `07`) | Per-tenant deliverability scorecards, seed-test inbox-placement results, blacklist watchlist, complaint/bounce-rate trend, DLQ/queue-depth (D10) | Trigger a seed/placement test; acknowledge a blacklist alert; open the affected tenant's reputation pool | `super_admin`, `support`, `read_only` (read); `super_admin`, `support` (act) |
| 3.4 | **Compliance & Audit** | Email audit-log viewer (IDs+actions only, never PII/body); DSAR tooling; `email_consent` records (cross-ref `06`) | Email-scoped `platform_audit_log` viewer, DSAR intake/cascade tracker, consent-record lookup (status, not content), retention/erasure status | Run/track a DSAR cascade; export an audit slice for an auditor; **read** consent state | `compliance_officer`, `super_admin` |
| 3.5 | **Per-Tenant Limits & Reputation** | Quotas, hard caps, per-user limits, complaint-rate circuit breaker, quarantine (cross-ref `07`) | Per-tenant quota/hard-cap/per-user-limit editor, circuit-breaker state, quarantine status, reputation-pool (D2) view | Edit quota/cap; arm/disarm circuit breaker; **pause/quarantine** a tenant's sending; lift quarantine | `super_admin` (write); `support` (pause on abuse); `read_only` (read) |
| 3.6 | **Global Suppression** | Platform-wide blocks distinct from tenant suppression (D4 gates every send) | Global `email_suppression` (scope=`global`) list, reason/source, blind-indexed keys, add/import surface | Add/remove a global suppression; bulk-import a global block-list; trace which sends a key blocked | `compliance_officer`, `super_admin` |
| 3.7 | **Billing & Usage (Email Volume)** | Metered ESP sends, per-tenant cost, FinOps (cross-ref operations) | Per-tenant send-volume + ESP-cost meter, plan/quota-vs-usage, cost-per-tenant trend, overage flags | Export usage for invoicing; flag a tenant for cost review; (read-only on the money itself) | `billing_ops`, `super_admin` (read); `super_admin` (act) |

> **Cross-tenant note on every row:** the "act" actions above all run through `withPlatformTx` (or, for
> tenant-content, break-glass) and therefore **emit a `platform_audit_log` row naming the actor, action,
> target tenant, and reason** — there is no silent cross-tenant write. This is the non-negotiable that
> `06-compliance.md` and `list-plan/07 §5` both depend on.

---

## 3. Section detail

Each subsection follows the same shape: **purpose · key elements · primary actions · role gating** — the
shape `list-plan/07` and the brief require.

### 3.1 Tenant Mailbox & Domain Management

**Purpose.** Give platform-admins a per-tenant view of the *connection layer* — every
`mailbox_integration` a tenant has connected and every `sending_domain` it owns — so support can diagnose a
"my email won't send" ticket and so an admin can see, at a glance, which tenants are mis-authenticated
(SPF/DKIM/DMARC failing) and therefore a deliverability risk to shared infrastructure. This is the internal
counterpart to the tenant's own mailbox/domain settings in `10-web-surface.md`; the admin sees the **same
state, across all tenants, read-mostly**.

**Key elements.**
- **Per-tenant mailbox list** — one row per `mailbox_integration`: provider (Gmail/M365/SMTP), owner
  (`owner_user_id`), connection status (connected / token-expired / disconnected / error), last-send
  timestamp, daily-send count (aggregate, not recipients). Cursor-paginated + virtualized across a tenant's
  mailboxes and across tenants.
- **Domain DNS-auth panel** — per `sending_domain`: SPF, DKIM, DMARC each shown as **pass / fail / pending**
  with the *expected vs observed* record (the diagnostic detail deliverability ops consoles standardize on —
  continuous SPF/DKIM/DMARC validation plus instant alerts when a record breaks
  ([GlockApps](https://glockapps.com/); [Mailtrap deliverability tools, 2026](https://mailtrap.io/blog/email-deliverability-tools/))).
- **Custom tracking-domain (D3) CNAME status** — per tenant: the `track.<tenant-subdomain>` CNAME target and
  its resolve/verify state, since open/click tracking and link rewriting depend on it.
- **Verification badges** — a single rollup: "domain verified & authenticated" vs "action needed", so the
  fleet view sorts the at-risk tenants to the top.

**Primary actions.**
- **Re-trigger a DNS recheck** for a tenant's `sending_domain` (queues a verify job; D10 queue-backed) —
  audited `admin.email.domain.recheck`.
- **Force re-verify / mark a mailbox disconnected** when a tenant's token is wedged and support needs to
  prompt a reconnect — audited `admin.email.mailbox.disconnect`. The admin **cannot** see or extract the
  OAuth refresh token or SMTP password (D7 — secrets are server-side, KMS target; the UI shows
  *connected-with-provider-X*, never the credential).
- **Open the tenant's reputation pool** (`07`) from a domain row, linking domain auth state to deliverability.

**Role gating.** Read for all staff tiers including `read_only`/`compliance_officer`; **act**
(recheck/disconnect) for `super_admin` and `support`. No tier sees secrets. Lives in `apps/admin`
(Mailboxes & Domains page) → `apps/api/src/features/admin/` (new `email/` routes alongside `providerConfigs.ts`).

| Field | Value |
|---|---|
| **Purpose** | Cross-tenant view + repair of the mailbox/domain connection layer; surface DNS-auth risk |
| **Key elements** | Per-tenant `mailbox_integration` list; SPF/DKIM/DMARC panel; D3 tracking-domain CNAME state; verification badges |
| **Primary actions** | DNS recheck; force re-verify; mark mailbox disconnected; open reputation pool. **Never** reveal secrets (D7) |
| **Who can access** | `super_admin`, `support` (act); `read_only`, `compliance_officer` (read) |

---

### 3.2 Sending-Infrastructure Configuration

**Purpose.** This is where platform-admins operate **Decision D1 — the hybrid provider strategy**. TruePoint
sends through a mix of providers/IP pools and the admin **configures the routing**: which ESP accounts exist,
how IP pools are carved (shared vs dedicated), the warmup policy that ramps new domains/IPs, and the
**provider routing rules** that decide which tenant/segment sends through which provider+pool. The modern
reference pattern is SES's per-tenant *dedicated configuration sets, identities, and IP* model
([AWS SES tenant isolation, Aug 2025](https://aws.amazon.com/about-aws/whats-new/2025/08/amazon-ses-tenant-isolation-automated-reputation-policies/))
and the agency multi-tenant pattern of isolating client reputation by pool
([Mailpool multi-tenant architecture](https://www.mailpool.ai/blog/multi-tenant-email-architecture-how-agencies-isolate-client-reputation-risk)).

**Key elements.**
- **ESP-account registry** — each configured provider account: name, provider type, region/residency, status
  (active/disabled), and a **redacted credential reference** (e.g. `key …last4`, KMS key id) — **never the raw
  secret** (D7). The screen makes the *existence and health* of a credential auditable without exposing it.
- **IP-pool definitions** — shared pools and dedicated pools, each with member IPs, current warmup stage, and
  the tenants/reputation-pools (D2) routed onto it.
- **Warmup-policy presets** — ramp curves (volume/day over N days) applied to new domains/IPs/mailboxes; the
  warmup discipline every cold-email platform now bundles
  ([Instantly 90% deliverability, 2026](https://instantly.ai/blog/how-to-achieve-90-cold-email-deliverability-in-2025/)).
- **Provider-routing rules (D1)** — the ordered rules mapping tenant / volume-band / send-type → provider +
  IP pool, plus per-tenant overrides for a tenant on a dedicated pool.

**Primary actions.** Register / disable an ESP account; define / edit an IP pool; assign a warmup preset;
set a routing rule or per-tenant override. All are config writes through `withPlatformTx`, audited
(`admin.email.infra.*`), and reuse the established **provider-config pattern already in the codebase**
(`apps/api/src/features/admin/providerConfigs.ts` — enable/disable + budget, `super_admin`-gated). No raw
secret is ever written back to the client; credential entry is a write-only field that hands off to the
server-side KMS path.

**Role gating.** **`super_admin` only** — this is global infrastructure; a misconfigured route or pool harms
every tenant. `read_only` may *view* the registry (no secrets) for diagnosis; no other tier writes.

| Field | Value |
|---|---|
| **Purpose** | Operate D1 hybrid provider strategy: ESP accounts, IP pools, warmup, provider routing |
| **Key elements** | ESP-account registry (redacted creds, D7); IP-pool defs (shared/dedicated); warmup presets; routing rules + per-tenant overrides |
| **Primary actions** | Register/disable ESP; define/edit IP pool; set warmup; set routing rule/override (all audited; no raw secrets) |
| **Who can access** | `super_admin` (write); `read_only` (view, no secrets) |

---

### 3.3 Deliverability Monitoring

**Purpose.** Continuous, **per-tenant** deliverability health so platform-admins catch a problem *before*
the tenant's pipeline dries up — the explicit value modern deliverability consoles sell ("continuous
monitoring is what separates teams that maintain 90%+ inbox rates from those who discover problems after
their pipeline has dried up" — [Instantly, 2026](https://instantly.ai/blog/how-to-achieve-90-cold-email-deliverability-in-2025/)).
This is the admin lens on the metrics defined in `03-deliverability.md` and the reputation isolation in
`07-multitenancy-reputation-isolation.md`. It tracks mainly in **P5** of the phase map (`13`), ahead of the
broader P6 admin build, because deliverability is the first cross-tenant risk that goes live with sending.

**Key elements.**
- **Per-tenant deliverability scorecard** — inbox-placement %, complaint rate, bounce rate (hard/soft),
  spam-folder rate, derived from `email_send` + `email_tracking_event` **aggregates** (never per-recipient
  rows). **D6: opens are informational, not a KPI** — the scorecard treats inbox-placement and
  reply/complaint signals as primary and labels opens as advisory.
- **Seed / inbox-placement tests** — admin-triggered placement runs across Gmail/Outlook/etc., the standard
  inbox-placement-test feature ([GlockApps](https://glockapps.com/); [Mailtrap, 2026](https://mailtrap.io/blog/email-deliverability-tools/)).
- **Blacklist watchlist** — per `sending_domain` / IP, current listing status with **instant blacklist
  alerts** when a domain/IP gets flagged ([Warmforge blacklist monitoring](https://www.warmforge.ai/blog/blacklist-monitoring-email-deliverability)).
- **Complaint/bounce-rate trend + threshold band** — so an admin sees a tenant *approaching* the
  circuit-breaker threshold (§3.5) before it trips.
- **Queue health (D10)** — fan-out queue depth, running/failed, and **DLQ** for the send pipeline (the same
  `system-health` proxy `routes.ts` already exposes via `sampleJobStatuses`, extended to the email queues).

**Primary actions.** Trigger a seed/placement test; acknowledge/snooze a blacklist alert (audited); jump
from a failing tenant to its reputation pool (§3.5) or domain-auth panel (§3.1) to act. Monitoring is
read-dominant; the *remediation* (pause/quarantine) lives in §3.5.

**Role gating.** Read for `super_admin`, `support`, `read_only`; act (run test / ack alert) for `super_admin`
and `support`. Aggregate-only — `billing_ops`/`compliance_officer` have no special deliverability powers here.

| Field | Value |
|---|---|
| **Purpose** | Continuous per-tenant deliverability health (cross-ref `03`, `07`); catch risk before pipeline impact |
| **Key elements** | Per-tenant scorecard (inbox-placement, complaint/bounce; D6 opens advisory); seed/placement tests; blacklist watchlist + alerts; complaint/bounce trend vs threshold; queue/DLQ (D10) |
| **Primary actions** | Run placement test; acknowledge blacklist alert; open reputation pool / domain panel |
| **Who can access** | `super_admin`, `support`, `read_only` (read); `super_admin`, `support` (act) |

---

### 3.4 Compliance & Audit

**Purpose.** The compliance officer's console for the email subsystem: a **privacy-safe audit-log viewer**,
**DSAR tooling**, and **consent-record lookup** — realizing **D9 (compliance enforced)**. It is the email
counterpart to the platform audit viewer that already exists at `apps/api/src/features/admin/auditLog.ts`
(super_admin / compliance_officer gated), extended with the email-scoped action vocabulary and DSAR cascade
from `06-compliance.md`. Enterprise privacy programs treat exactly this — automated DSAR handling, ROPA,
**immutable audit trails** — as essential operational infrastructure, not optional
([OneTrust/DataGrail/Transcend class of tools](https://secureprivacy.ai/blog/what-are-dsar-tools);
[GDPR↔SOC2 unified evidence](https://sprinto.com/blog/soc-2-vs-gdpr/)).

**Key elements.**
- **Email audit-log viewer — IDs + actions ONLY, never PII or body.** Filterable on actor, action
  (`admin.email.*`, send/suppression/consent actions), target tenant, time. The row carries
  `{ actor_user_id, action, target_type, target_id, tenant_id, workspace_id, ip, metadata, occurred_at }` —
  **no recipient address, no rendered `email_send` body** (the hard rule from the constraints digest and
  `list-plan/07 §5`). The trail is **append-only** (UPDATE/DELETE raise for every role) and reading it is
  *itself* audited (`admin.read_audit_log`). Cursor-paginated + virtualized.
- **DSAR tooling** — intake → identity-link → **cascade tracker**: which email entities a subject's
  request touches (`email_consent`, `email_suppression`, `email_send` references) and the status of the
  erase/export cascade. On erasure the cascade writes a **`global` suppression row** to block re-contact
  (the cascade contract owned by `06-compliance.md`; mechanism mirrors `list-plan/07 §6` / ADR-0021).
- **Consent records** — lookup of `email_consent` **state** for a subject/tenant (granted/withdrawn, source,
  timestamp) — the *fact and provenance* of consent, **not** message content.
- **Auditor export** — a bounded, audited export of an audit slice (IDs+actions) for a SOC 2 / GDPR auditor.

**Primary actions.** Run and track a DSAR cascade; export an audit slice; read consent state. All writes
(DSAR actions) run through the **privileged DSAR fan-out** (`withPrivilegedTx` / `leadwolf_admin`), separately
audited (`admin.email.dsar_action`) — a legally-mandated path, not casual access (`06`, `list-plan/07 §3.1`).

**Role gating.** **`compliance_officer` and `super_admin` only.** `support`/`billing_ops`/`read_only` do not
operate DSAR or read the audit trail. Lives in `apps/admin` (Compliance page) → `apps/api/.../admin/auditLog.ts`
+ a new DSAR module.

| Field | Value |
|---|---|
| **Purpose** | Privacy-safe audit viewer + DSAR tooling + consent lookup for email (D9; cross-ref `06`) |
| **Key elements** | Email audit viewer (IDs+actions only, never PII/body; append-only); DSAR cascade tracker (writes `global` suppression on erase); `email_consent` state lookup; auditor export |
| **Primary actions** | Run/track DSAR cascade; export audit slice; read consent state (all DSAR writes audited via privileged fan-out) |
| **Who can access** | `compliance_officer`, `super_admin` |

---

### 3.5 Per-Tenant Limits & Reputation

**Purpose.** The control room for **D2 (per-tenant reputation isolation)** and the FinOps/abuse guardrails:
**quotas, hard caps, per-user limits, the complaint-rate circuit breaker, and quarantine**. This is where an
admin contains a tenant whose list is torching reputation — without touching any other tenant — exactly the
auto-isolation model SES shipped ("if reputation issues are detected, SES can automatically pause the
affected tenant to protect other email streams," with Standard/Strict policy levels —
[AWS SES tenant isolation, Aug 2025](https://aws.amazon.com/about-aws/whats-new/2025/08/amazon-ses-tenant-isolation-automated-reputation-policies/);
tenant-level suppression so "bounces and complaints only affect the tenant that sent the email" —
[StackPioneers SES tenant isolation, Aug 2025](https://stackpioneers.com/2025/08/02/comprehensive-guide-to-amazon-ses-tenant-isolation-and-reputation-policies/)).
Detail and thresholds are owned by `07-multitenancy-reputation-isolation.md`.

**Key elements.**
- **Quota / hard-cap / per-user-limit editor** — per-tenant daily/monthly send quota, an absolute **hard
  cap**, and a **per-user limit** (the three FinOps controls the operations skill mandates). **Known gap (track
  it):** the per-tenant quota gates are currently **UNWIRED** — the admin editor is the surface, but the
  enforcement wiring is a P6 build item (`13`); the UI must label any unwired control as not-yet-enforcing
  rather than imply a guarantee it does not have.
- **Complaint-rate circuit breaker** — per-tenant state (armed/tripped) with the threshold and current
  complaint rate; tripping **auto-pauses** that tenant's sending (Standard vs Strict policy, per `07`).
- **Quarantine** — a status flag on the tenant's send capability (analogous to `list-plan/07 §6` list
  quarantine) that **halts the reputation pool** while leaving data intact and the tenant notified.
- **Reputation-pool view (D2)** — the tenant's `sending_domain` + mailbox set (+ optional dedicated IP) as a
  single isolation unit, with its current standing.

**Primary actions.** Edit quota / hard cap / per-user limit; **arm/disarm** the circuit breaker;
**pause / quarantine** a tenant's sending and **lift** it. Every action is audited
(`admin.email.quota.set`, `admin.email.circuit.trip`, `admin.email.quarantine` / `.unquarantine`) and the
tenant is notified — there is no silent throttle.

**Role gating.** `super_admin` writes all controls; **`support` may pause/quarantine on confirmed abuse**
(the incident lever) but not edit quotas; `read_only` reads. `billing_ops` sees the *numbers* via §3.7, not
the controls.

| Field | Value |
|---|---|
| **Purpose** | Operate D2 isolation + FinOps/abuse guardrails: quotas, hard caps, per-user limits, complaint-rate circuit breaker, quarantine (cross-ref `07`) |
| **Key elements** | Quota/cap/per-user editor (gate-wiring is a known gap — label clearly); circuit-breaker state + threshold; quarantine flag; reputation-pool (D2) view |
| **Primary actions** | Edit limits; arm/disarm circuit breaker; pause/quarantine + lift (audited; tenant notified) |
| **Who can access** | `super_admin` (write); `support` (pause/quarantine on abuse); `read_only` (read) |

---

### 3.6 Global Suppression

**Purpose.** A **platform-wide** suppression list, **distinct from per-tenant suppression**, that blocks an
address/domain across *every* tenant — for confirmed spam-traps, role accounts we never mail, regulator
demands, and addresses that complained against the platform. This is the `scope = global` tier of
`email_suppression`, and per **D4 it gates every send** in-transaction (the unbypassable suppression gate
that fronts the send path, mirroring `assertNotSuppressed` in the list subsystem). Subscribing to all
feedback loops and **never re-adding a complainant without explicit reconfirmation** is the discipline
multi-tenant ESPs codify ([MailChannels multi-tenant deliverability, 2026](https://www.mailchannels.com/multi-tenant-email-deliverability/)).

**Key elements.**
- **Global suppression list** — `email_suppression` rows with `scope = global`: the **blind-indexed key**
  (email/domain — never plaintext at rest), `match_type`, reason, source (FBL / manual / regulator /
  spam-trap), added-by, added-at. Cursor-paginated + virtualized (this list grows large).
- **Reason / source taxonomy** so an admin can later justify and, where lawful, reverse a global block.
- **"Which sends did this block"** trace — an aggregate count of suppressed-at-send events for a key
  (counts, not recipient identities), so an admin can gauge impact before removing a global entry.

**Primary actions.** Add / remove a single global suppression; **bulk-import** a global block-list (queue-backed,
D10, audited); trace a key's block impact. All writes are audited (`admin.email.suppression.global.add` /
`.remove`); removal of a complaint-origin entry should require a senior-role confirmation (do not silently
un-suppress a complainant).

**Role gating.** **`compliance_officer` and `super_admin` only** — global suppression affects every tenant's
deliverability and a wrong entry blocks legitimate mail platform-wide. `support`/`billing_ops`/`read_only`
do not write here.

| Field | Value |
|---|---|
| **Purpose** | Platform-wide blocks distinct from tenant suppression; the `scope=global` tier that D4 gates every send against |
| **Key elements** | Global `email_suppression` list (blind-indexed keys, never plaintext); reason/source taxonomy; per-key block-impact trace (counts only) |
| **Primary actions** | Add/remove global suppression; bulk-import (queue-backed, audited); trace block impact (un-suppress of complainant needs senior confirm) |
| **Who can access** | `compliance_officer`, `super_admin` |

---

### 3.7 Billing & Usage (Email Volume)

**Purpose.** The FinOps lens on email: **metered ESP sends, per-tenant cost, and overage detection** so
billing-ops can invoice email volume and so platform-admins control the metered ESP spend (the operations
skill's per-tenant FinOps mandate — quota + hard cap + per-user limit, surfaced as cost here and enforced in
§3.5). Email is a **usage-metered** line item like SES/MailerSend volume pricing, and the FinOps risk is the
classic one — *sudden, unexpected usage spikes* — which is why per-tenant metering and overage flags matter
([Schematic metered billing](https://schematichq.com/blog/metered-billing);
[Zenskar metered billing for SaaS, 2026](https://www.zenskar.com/blog/metered-billing);
[Amazon SES volume pricing, 2026](https://smtpedia.com/amazon-aws-ses-pricing/)).

**Key elements.**
- **Per-tenant send-volume + ESP-cost meter** — `email_send` counts by period, mapped to provider unit cost
  (per §3.2 routing), giving **cost-per-tenant**. **Aggregate-only** — counts/sums, never a recipient row
  (the same privacy line as `list-plan/07 §7`, where billing sees the numbers that drive invoices, not the
  contacts behind them).
- **Plan / quota-vs-usage** — each tenant's configured quota (§3.5) against actual consumption, with %-to-cap.
- **Cost-per-tenant trend + overage flags** — tenants trending over plan or showing an anomalous spike are
  flagged for review (the FinOps early-warning the operations skill requires; observability target = cost
  per tenant).
- **Provider cost rollup** — total ESP spend by provider/pool, for negotiating and capacity planning.

**Primary actions.** Export per-tenant usage for invoicing; flag a tenant for cost review; drill from a
flagged tenant into its quota controls (§3.5). Billing-ops is **read on the money** — it reports aggregates;
it does not change quotas (that is `super_admin`, §3.5) and never reaches recipient data.

**Role gating.** Read for `billing_ops` and `super_admin`; the *act* of changing limits in response lives in
§3.5 (`super_admin`). `support`/`compliance_officer`/`read_only` are not billing roles here.

| Field | Value |
|---|---|
| **Purpose** | FinOps on email: metered ESP sends, per-tenant cost, overage detection (cross-ref operations) |
| **Key elements** | Per-tenant send-volume + cost meter (aggregate-only); plan/quota-vs-usage; cost-per-tenant trend + overage flags; provider cost rollup |
| **Primary actions** | Export usage for invoicing; flag for cost review; drill into quota controls (§3.5) |
| **Who can access** | `billing_ops`, `super_admin` (read); `super_admin` (act, via §3.5) |

---

## 4. TruePoint grounding — where this lands and how it stays safe

- **App + API.** Customer-invisible pages live in **`apps/admin`** (one page/section per §3, using
  `@leadwolf/ui` + `StateSwitch`). The API extends **`apps/api/src/features/admin/`** — a new `email/`
  route group mounted on `adminRoutes`, inheriting the existing `authn` + `platformAdmin` chain
  (`routes.ts` lines 36–37) and adding `requireStaffRole(...)` per section. Read shapes live in
  `@leadwolf/db` (a `platformAdminRepository` extension + `emailRepository.ts`); cross-tenant reads use
  **`withPlatformTx`** and are **bounded** (`PLATFORM_READ_LIMIT`) and **audited** in-transaction.
- **Cross-tenant access is the audited `leadwolf_admin` path.** No email-admin endpoint reaches tenant data
  except through `withPlatformTx` (metadata/aggregate) or break-glass impersonation (record-level, `list-plan/07 §4`).
  Every privileged read/write writes a `platform_audit_log` row; the audit table is append-only and reading it
  is itself audited.
- **Contract.** `/api/v1`; Zod schemas in `@leadwolf/types`; **cursor pagination** on every list; RFC 9457
  error envelope; **Idempotency-Key** on admin writes (D5 — admin-triggered jobs like rechecks/imports are
  idempotent). Fan-out and imports are **queue-backed** (D10); the console shows queue depth / running /
  failed / **DLQ**.
- **Security final say.** Platform-admin is the highest privilege; **secrets are never rendered** (D7); audit
  rows carry **IDs + actions, never PII or bodies**; deliverability and billing are **aggregate-only**.
  Mutations are step-up + senior-role-gated. These are boundaries, not UI conventions — UI hiding is never
  the control (`list-plan/07 §1`).
- **Known gaps this surface must track (constraints digest):** **KMS not yet done** (§3.1/§3.2 must show
  redacted credential refs and not imply hardware-backed secrecy yet); **per-tenant quota gates UNWIRED**
  (§3.5 controls exist before enforcement — label clearly); **no per-endpoint cross-tenant HTTP isolation
  test** (the email-admin routes need the isolation itest from `list-plan/07 §8`); **residency siloing
  absent** (§3.2 ESP-account region is a field today, not an enforced boundary); **confirm leader-locked
  scheduler** for the fan-out the console observes.

---

## 5. Cross-references

- **`00-overview.md`** — D1–D10 Locked Decisions and the Shared Vocabulary used verbatim throughout.
- **`03-deliverability.md`** — the deliverability metrics (inbox-placement, blacklist, complaint/bounce)
  that §3.3's admin scorecard renders.
- **`06-compliance.md`** — the audit-log shape (IDs+actions, no PII/body), DSAR cascade, and `email_consent`
  semantics that §3.4 operationalizes; the suppression-gate contract behind §3.6.
- **`07-multitenancy-reputation-isolation.md`** — the reputation-pool (D2) model, quota/cap/per-user limits,
  complaint-rate circuit breaker, and quarantine that §3.5 controls; the per-tenant vs global suppression
  split behind §3.6.
- **`09-data-model.md`** — owns the canonical entities (`mailbox_integration`, `sending_domain`,
  `email_send`, `email_tracking_event`, `email_suppression`, `email_consent`, …) these screens read.
- **`10-web-surface.md`** — the customer-facing mirror of §3.1; the admin surfaces here are the cross-tenant
  internal counterpart, never tenant-visible.
- **`12-roles-permissions.md`** — the authoritative `requireStaffRole(...)` tier definitions
  (`super_admin` / `support` / `billing_ops` / `compliance_officer` / `read_only`) used in every "who can
  access" cell above.
- **`13-rollout-phases.md`** — these surfaces land mainly in **P6 Admin + governance**; deliverability
  monitoring (§3.3) tracks **P5**.
- **`list-plan/07-admin-staff-governance.md`** — the shape and privacy-first staff stance this doc mirrors
  (break-glass, append-only audit, aggregate-only billing, customer-visible access).

### Sources (admin / deliverability-ops console patterns, 2024–2026)

- [Amazon SES — tenant isolation with automated reputation policies (Aug 2025)](https://aws.amazon.com/about-aws/whats-new/2025/08/amazon-ses-tenant-isolation-automated-reputation-policies/)
- [StackPioneers — Comprehensive Guide to Amazon SES Tenant Isolation and Reputation Policies (Aug 2025)](https://stackpioneers.com/2025/08/02/comprehensive-guide-to-amazon-ses-tenant-isolation-and-reputation-policies/)
- [MailChannels — Multi-Tenant Email Deliverability (2026)](https://www.mailchannels.com/multi-tenant-email-deliverability/)
- [Mailpool — Multi-Tenant Email Architecture: Isolating Client Reputation Risk](https://www.mailpool.ai/blog/multi-tenant-email-architecture-how-agencies-isolate-client-reputation-risk)
- [GlockApps — Email Deliverability & Inbox Placement Testing](https://glockapps.com/)
- [Mailtrap — 17 Best Email Deliverability Tools (2026)](https://mailtrap.io/blog/email-deliverability-tools/)
- [Warmforge — How Blacklist Monitoring Improves Email Deliverability](https://www.warmforge.ai/blog/blacklist-monitoring-email-deliverability)
- [Instantly — How to Achieve 90%+ Cold Email Deliverability (2026)](https://instantly.ai/blog/how-to-achieve-90-cold-email-deliverability-in-2025/)
- [SecurePrivacy — DSAR Tools Explained](https://secureprivacy.ai/blog/what-are-dsar-tools)
- [Sprinto — SOC 2 vs GDPR (unified evidence / immutable audit)](https://sprinto.com/blog/soc-2-vs-gdpr/)
- [Schematic — Metered Billing Explained for SaaS](https://schematichq.com/blog/metered-billing)
- [Zenskar — Metered Billing for SaaS (2026)](https://www.zenskar.com/blog/metered-billing)
- [Amazon SES Pricing (2026)](https://smtpedia.com/amazon-aws-ses-pricing/)
