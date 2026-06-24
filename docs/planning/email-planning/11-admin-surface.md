# Email — Admin Surface (`/admin`) Plan (11)

> **Status:** Plan (not yet built). **Owner:** Platform + Security. **Last updated:** 2026-06-24.
> This is the **surface plan for the internal `/admin` console** of the email subsystem — the
> platform-staff console in **`apps/admin`** (API in **`apps/api/src/features/admin/`**).
> It is the internal mirror of the customer-facing plan in `10-web-surface.md`: where `10` lays out
> what a *tenant* sees and does, this doc lays out what **TruePoint platform-staff** see and do
> **across** tenants. It cites the Locked Decisions (D1–D11) and the Shared Vocabulary in
> `00-overview.md`, the canonical entities in `09-data-model.md`, the deliverability monitoring in
> `03-deliverability.md`, the multitenancy/reputation isolation in `07-multitenancy-reputation-isolation.md`,
> the compliance mechanics in `06-compliance.md`, the role tiers in `12-roles-permissions.md`, and the
> phase contract in `13-rollout-phases.md` (this work is mainly **P6 Admin + governance**; deliverability
> monitoring tracks **P5**).
>
> **This doc EXTENDS the already-built admin console — it does not design a new one (D11).** The staff
> console in `apps/admin/src/` is **fully built, not a stub**: **Tenants** (`/tenants`), **Users**
> (`/users` + impersonation), **Providers** (`/provider-configs`), **Feature flags** (`/feature-flags`),
> **Staff** (`/staff`), **Audit log** (`/audit-log`), and **System health** (`/system-health`). Every
> email-admin capability below is **mapped onto one of those existing pages**; only **three** sections
> are genuinely-new pages. The plan adds **email panels to existing features**, it does not fork a
> parallel console.
>
> **Precedence (root `CLAUDE.md`):** **Security has the final say on whether something is safe.**
> **Platform owns the tenancy mechanism (RLS), the API contract, and scale.** Every surface below is
> **platform-staff scoped — NEVER tenant-visible**. Every cross-tenant read or write goes through the
> **audited `leadwolf_admin` path** (`withPlatformTx`) and is **gated by the `platformAdmin`
> middleware + `requireStaffRole(...)`** (`apps/api/src/features/admin/routes.ts` lines 36–37).
> **Secrets are never rendered (D7).** Audit logs store **IDs + actions, never PII or message bodies.**
> This mirrors the shape of `list-plan/07-admin-staff-governance.md`.

---

## 1. Scope, principles, and what makes this surface "admin"

The email subsystem hands TruePoint a new class of cross-tenant operational responsibility: we are now a
**sender of record** on behalf of every tenant. A tenant's bad list, spam-trap hit, or complaint spike is
not just *their* problem — left unchecked it poisons shared infrastructure (an ESP sub-account, an IP pool,
a tracking-domain CNAME). The `/admin` surface gives platform-staff the controls modern multi-tenant email
platforms now ship as table stakes: **per-tenant reputation isolation with automated auto-pause**,
**tenant-level metrics**, and **tenant-scoped + global suppression** — the exact model AWS SES formalized
in its August 2025 *tenant isolation with automated reputation policies* release, where an admin configures
dedicated per-tenant identities, sees real-time per-tenant bounce/complaint rates, and SES "can
automatically pause the affected tenant to protect other email streams." ([AWS SES tenant isolation, Aug
2025](https://aws.amazon.com/about-aws/whats-new/2025/08/amazon-ses-tenant-isolation-automated-reputation-policies/);
[MailChannels multi-tenant deliverability, 2026](https://www.mailchannels.com/multi-tenant-email-deliverability/))

**We extend, we do not rebuild (D11).** The console already exists and already enforces every safety
property below. The email work is **additive**: an `email.*` flag namespace on the existing feature-flags
page, an ESP `ProviderAdapter` row class on the existing provider-configs page, email queue/ingestion SLOs
on the existing system-health page, an `email.*` action vocabulary on the existing audit-log viewer, and a
per-tenant email tab on the existing tenant detail. Only **sending-domain management**, **per-tenant
deliverability monitoring**, and **global suppression** are genuinely-new pages (§3.5–§3.7).

**Operating principles (inherited, not re-derived):**

- **Platform-staff scoped, never tenant-visible.** Nothing in this doc renders in `apps/web`. Every page
  lives in `apps/admin/src/features/*`; every endpoint sits behind `apps/api/src/features/admin/` under the
  existing `authn` + `platformAdmin` middleware chain (`routes.ts` already does
  `adminRoutes.use("*", platformAdmin)` at lines 36–37), with finer **`requireStaffRole(...)`** gating per
  section (`12-roles-permissions.md`).
- **Cross-tenant access is the audited exception.** Admin reads/writes run through **`withPlatformTx`**
  (the `leadwolf_admin` owner-role RLS path), which writes a `platform_audit_log` row **in the same
  transaction** as the action and **bounds** every cross-tenant read (`PLATFORM_READ_LIMIT`). There are no
  unbounded cross-tenant scans (`routes.ts` lines 1–5, 116–147). This is the highest-privilege surface in
  the API; **nothing reaches it without `pa === true`** (`platformAdmin`).
- **No PII, no bodies, no secrets.** Per **D7**, admins never see raw ESP credentials/OAuth tokens (KMS
  target, app-AES-GCM today; server-side only). The existing provider-config endpoint already proves the
  shape — it returns `keyHint: null` with a `// WIRE: masked last-4 from the KMS-managed provider secret
  store` comment and **never** the secret (`providerConfigs.ts` line 59). Per `06-compliance.md`, the audit
  viewer renders **IDs + actions only** — never a recipient address, never a rendered email body.
  Deliverability and usage analytics are **aggregate** (counts/rates), mirroring the privacy-first staff
  stance of `list-plan/07 §1`.
- **Vanilla React + `StateSwitch` + `DataTable` — NOT TanStack Query.** Every admin screen already uses the
  shipped pattern (ADR-0016): `useState` / `useCallback`, `fetchWithAuth` (in-memory access token), the
  `MaybeList<T>{items, available}` envelope, `StateSwitch` (loading / empty / error / data) + `EmptyState`
  + `DataTable` from `@leadwolf/ui`, `var(--tp-*)` tokens, WCAG 2.2 AA, i18n, light theme only.
  Representative: `apps/admin/src/features/provider-configs/{api.ts, hooks/useProviderConfigs.ts}` and
  `features/system-health/`. **There are no `useQuery` / query-keys anywhere in `apps/admin`** — new email
  panels follow the same vanilla pattern. Every large table (sends, suppression, audit, mailboxes across
  tenants) is **cursor-paginated + virtualized**.
- **Read-only-first; writes are step-up + audited.** Day-to-day operation is observation. A *mutation*
  (disconnect a tenant's mailbox, pause a tenant, edit a quota, add a global suppression) is a deliberate,
  separately-audited action gated to a senior staff role — the same break-glass discipline `list-plan/07 §4`
  applies to list contents, and the same one `providerConfigs.ts` applies (`requireStaffRole("super_admin")`
  on every provider write, line 32).

> **The single narrow exception** to "admins never read tenant data" is the break-glass impersonation path
> — **the existing `apps/admin` Users page + `apps/api/src/features/admin/impersonation.ts`** (time-boxed,
> audited, `super_admin`/`support` only). The email-admin surfaces below are designed so routine ops —
> deliverability triage, quota changes, suppression, billing — **never need** record-level access to a
> tenant's recipients or message bodies; that is what break-glass is for, and it is the exception, not the
> path.

---

## 2. The admin section catalog (the contract)

Seven sections. The first four **extend existing `apps/admin` pages**; the last three are **genuinely-new
pages** (D11). The table below is the authoritative index. **"Existing page / API"** names the real surface
each maps onto; **"New?"** marks the three new builds; **"Who can access"** names the `requireStaffRole(...)`
tiers from `12-roles-permissions.md` (recap: `super_admin`, `support`, `billing_ops`, `compliance_officer`,
`read_only` — all *behind* the coarse `platformAdmin` gate).

| § | Section | Maps onto (existing page → API) | New? | Purpose | Who can access |
|---|---|---|---|---|---|
| 3.1 | **ESP / Provider config** | **Providers** `/provider-configs` → `apps/api/src/features/admin/providerConfigs.ts` | extend | Add ESP/mailbox providers to the pluggable `ProviderAdapter` registry alongside the enrichment providers; enable/disable + budget; **never** render secrets (D7) | `super_admin` (write); `read_only` (view, no secrets) |
| 3.2 | **Feature flags — `email.*` rollout** | **Feature flags** `/feature-flags` → `routes.ts` `/feature-flags` (ADR-0011) | extend | Stage the M12 rollout behind `email.*` flags: global default + per-tenant overrides (e.g. `email.sending`, `email.tracking`, `email.warmup`) | `super_admin` |
| 3.3 | **System health — email queues + SLOs** | **System health** `/system-health` → `routes.ts` `/system-health` | extend | Email queue depth, send success rate, tracking-ingestion lag, provider latency SLOs + DLQ — extend the existing `sampleJobStatuses` proxy to the `email_*` queues (D10) | `super_admin`, `support`, `read_only` |
| 3.4 | **Compliance & Audit (email scope)** | **Audit log** `/audit-log` → `apps/api/src/features/admin/auditLog.ts` | extend | The shipped `audit_log` viewer (IDs+actions only) filtered to the `send` / `enroll` / `unsubscribe` / `suppression.add`-class actions; DSAR cascade tracking; `consent_records` state lookup (D9) | `compliance_officer`, `super_admin` |
| 3.5 | **Sending-Domain management + DNS-auth** | **NEW** page `apps/admin/src/features/sending-domains/` → **NEW** `apps/api/.../admin/email/domains.ts` | **NEW** | Cross-tenant `sending_domain` view + `mailbox_integration` connection layer; SPF/DKIM/DMARC + D3 tracking-CNAME state; recheck/re-verify | `super_admin`, `support` (act); `read_only`, `compliance_officer` (read) |
| 3.6 | **Per-tenant deliverability monitoring** | **NEW** page `apps/admin/src/features/deliverability/` → **NEW** `apps/api/.../admin/email/deliverability.ts` (+ a tab on **Tenants** detail) | **NEW** | Per-tenant inbox-placement, complaint/bounce rate, blacklist watchlist, reputation pool + circuit breaker / quarantine (cross-ref `03`, `07`) | `super_admin` (write); `support` (pause on abuse); `read_only` (read) |
| 3.7 | **Global suppression** | **NEW** page `apps/admin/src/features/global-suppression/` → **NEW** `apps/api/.../admin/email/suppression.ts` | **NEW** | The `suppression_list` `scope = global` tier that **D4 gates every send** against (the unbypassable `assertNotSuppressed` gate, platform-wide) | `compliance_officer`, `super_admin` |

> **Per-tenant limits & email-volume billing are NOT a separate page** — they live on the **existing
> Tenants page** (`apps/admin/src/features/tenants/`, which already shows plan / status / seats / credits per
> `routes.ts` lines 58–77). M12 adds a **per-tenant email tab** to the tenant detail: send-quota,
> reputation standing, and email-volume usage. The send-quota itself reuses the shipped `creditRepository`
> `SELECT … FOR UPDATE` no-overdraft lock pattern (ADR-0007) — **a new counter, not a new mechanism** (D11).
> That tab is detailed in §3.6 (reputation/quota controls) and §4 (billing/usage rollup).

> **Cross-tenant note on every row:** the write actions above all run through `withPlatformTx` (or, for
> tenant-content, break-glass impersonation) and therefore **emit a `platform_audit_log` row naming the
> actor, action, target tenant, and reason** — there is no silent cross-tenant write. This is the
> non-negotiable that `06-compliance.md` and `list-plan/07 §5` both depend on, and it is already enforced
> by the shipped `withPlatformTx` (`routes.ts` lines 1–5).

---

## 3. Section detail

Each subsection follows the same shape: **purpose · key elements · primary actions · role gating** — the
shape `list-plan/07` and the brief require. **Sections 3.1–3.4 extend an existing page; 3.5–3.7 are the
three new pages.**

### 3.1 ESP / Provider config — extend the **Providers** page

**Purpose.** This is where platform-admins operate **Decision D1 — the hybrid provider strategy** — and it
is **not a new page**. The **Providers** page already ships at `apps/admin/src/features/provider-configs/`
backed by `apps/api/src/features/admin/providerConfigs.ts`, today registering the enrichment providers
(Apollo / ZoomInfo / Clearbit, a fixed `KNOWN_PROVIDERS` list — `providerConfigs.ts` lines 22–27) with
enable/disable + monthly budget, `super_admin`-gated, masked secrets. M12 **extends that registry into a
pluggable `ProviderAdapter` registry** that also holds the **ESP / mailbox-provider** rows (Amazon SES,
Postmark, SendGrid/Mailgun per D1, plus the Google/Microsoft OAuth + SMTP mailbox adapters that back the
`EmailSenderPort` seam). The modern reference pattern is SES's per-tenant *dedicated configuration sets,
identities, and IP* model ([AWS SES tenant isolation, Aug
2025](https://aws.amazon.com/about-aws/whats-new/2025/08/amazon-ses-tenant-isolation-automated-reputation-policies/)).

**Key elements.**
- **`ProviderAdapter` registry rows** — each configured provider account: name, provider type
  (`enrichment` | `esp` | `mailbox`), region/residency, status (active/disabled), `monthlyBudgetCents`,
  `rateLimitPerMin`, and a **`keyHint` masked credential reference** — **never the raw secret** (D7). The
  existing view already returns `keyHint: null` and `health: "unknown"` honestly until the KMS store +
  live probe land (`providerConfigs.ts` lines 59, 63); the ESP rows inherit that exact contract.
- **IP-pool + warmup associations (D1)** — for ESP adapters, the IP pools (shared/dedicated) and warmup
  presets the provider routes onto; the ordered routing rules mapping tenant / volume-band / send-type →
  provider + pool. The warmup discipline every cold-email platform now bundles
  ([Instantly 90% deliverability, 2026](https://instantly.ai/blog/how-to-achieve-90-cold-email-deliverability-in-2025/)).
- **Month-to-date spend** — the existing page already computes a real cross-tenant
  `monthToDateCentsByProvider` aggregation (`providerConfigs.ts` lines 47–51); ESP-send spend joins the
  same rollup (cross-ref §4).

**Primary actions.** Register / disable an ESP or mailbox provider; set its budget; (later) assign an IP
pool / warmup preset / routing rule. These reuse the **shipped endpoints verbatim** —
`POST /:provider/enabled` and `POST /:provider/budget` (`providerConfigs.ts` lines 71–94), extended only by
adding ESP/mailbox entries to `KNOWN_PROVIDERS`. All are config writes through `withPlatformTx`, audited
(`admin.set_provider_enabled` / `admin.set_provider_budget`, already wired). **No raw secret is ever written
back to the client**; credential entry is a write-only field handing off to the server-side KMS path.

**Role gating.** **`super_admin` only** for writes — the existing page already enforces
`providerConfigRoutes.use("*", requireStaffRole("super_admin"))` (`providerConfigs.ts` line 32), because a
misconfigured route or pool harms every tenant. `read_only` may *view* the registry (no secrets) for
diagnosis.

| Field | Value |
|---|---|
| **Maps onto** | **Providers** `/provider-configs` (`apps/admin/src/features/provider-configs/`) → `apps/api/src/features/admin/providerConfigs.ts` — **extend the existing registry, not a new page** |
| **Purpose** | Operate D1: add ESP/mailbox providers to the pluggable `ProviderAdapter` registry; enable/disable + budget; IP pool / warmup / routing |
| **Key elements** | `ProviderAdapter` rows (`keyHint` masked, D7); IP-pool + warmup associations; routing rules; MTD spend (existing aggregation) |
| **Primary actions** | Register/disable ESP; set budget; (later) assign pool/warmup/route — via the shipped `/enabled` + `/budget` endpoints (audited; no raw secrets) |
| **Who can access** | `super_admin` (write — existing gate); `read_only` (view, no secrets) |

---

### 3.2 Feature flags — `email.*` staged rollout — extend the **Feature flags** page

**Purpose.** The M12 rollout is staged behind **`email.*` feature flags on the already-built Feature flags
page** (`apps/admin/src/features/feature-flags/` → `routes.ts` `/feature-flags`, ADR-0011). This is **not a
new mechanism** — the page already supports a **global default + per-tenant overrides** with idempotent
upsert and an `evaluate/:tenantId` preview (`routes.ts` lines 149–244). M12 only adds the `email.*` flag
keys, so the highest-risk send path can be dark-launched, enabled for a pilot tenant, then ramped — the
phase discipline of `13-rollout-phases.md`.

**Key elements.**
- **The `email.*` flag namespace** — e.g. `email.sending` (the P1 send path), `email.tracking` (P3 event
  ingestion), `email.sequences` (P4 automation), `email.warmup` (P5), `email.inbox`. Each is a row on the
  existing page with its **global default** (`globalEnabled` / `defaultEnabled`) and its list of **per-tenant
  overrides** (`routes.ts` lines 156–179) — the staged-rollout lever.
- **Per-tenant override editor** — the existing `OverrideDialog` (`set or clear an override`,
  `enabled: null` clears it — `routes.ts` lines 210–232), reused to flip a single tenant onto `email.sending`
  for a pilot before the global default flips.
- **Evaluated-state preview** — the existing `GET /feature-flags/evaluate/:tenantId` (`routes.ts` lines
  237–244) shows the resolved state for a tenant (override else global default), so an admin can confirm a
  pilot tenant actually has `email.*` on.

**Primary actions.** Define / upsert an `email.*` flag (`PUT /feature-flags`); toggle its global default
(`POST /feature-flags/:key/global`); set / clear a per-tenant override (`POST /feature-flags/:key/tenant`).
**All three endpoints already exist** and audit via the ADR-0032 `feature_flag.set` action (`routes.ts`
lines 181–232) — M12 reuses them unchanged. The 404 on an unknown flag is thrown **inside** the tx so the
audit row rolls back (`routes.ts` lines 197–207) — that property carries over to the `email.*` keys for free.

**Role gating.** **`super_admin`** — flags govern global rollout. (The page sits behind the coarse
`platformAdmin` gate; flag writes are a senior-staff action, consistent with the rest of the console.)

| Field | Value |
|---|---|
| **Maps onto** | **Feature flags** `/feature-flags` (`apps/admin/src/features/feature-flags/`) → `routes.ts` `/feature-flags` (ADR-0011) — **add `email.*` keys, not a new page** |
| **Purpose** | Stage the M12 rollout: `email.*` global default + per-tenant overrides; dark-launch → pilot → ramp |
| **Key elements** | `email.*` namespace (`email.sending` / `.tracking` / `.sequences` / `.warmup` / `.inbox`); per-tenant `OverrideDialog`; `evaluate/:tenantId` preview |
| **Primary actions** | Upsert flag; toggle global; set/clear per-tenant override — via the shipped endpoints (audited `feature_flag.set`) |
| **Who can access** | `super_admin` |

---

### 3.3 System health — email queues + SLOs — extend the **System health** page

**Purpose.** Email send and event ingestion are queue-backed (**D10**: `email_send`, `email_tracking`,
`email_warmup`, `email_sequence_tick`), and their health belongs on the **already-built System health page**
(`apps/admin/src/features/system-health/` → `routes.ts` `/system-health`). That page already renders service
status + a queue-depth/DLQ proxy by tallying job statuses (`sampleJobStatuses`, `queueDepth`,
`deadLetter` — `routes.ts` lines 116–147). M12 **extends the same proxy to the `email_*` queues** and adds
the email-specific SLOs, so an admin catches a backed-up send queue or a stalled tracking ingest before it
becomes a tenant-visible outage.

**Key elements.**
- **Email queue depth + DLQ (D10)** — the four `email_*` BullMQ queues tallied the same way the existing
  `byStatus` / `queueDepth` / `deadLetter` are (`routes.ts` lines 123–146): queued / running / failed per
  queue, with the dead-letter count surfaced as the at-risk number. The existing comment is explicit that
  this is the *proxy until the worker metrics surface lands* (`routes.ts` lines 116–117) — the email SLOs
  ride the same honest proxy.
- **Send success rate** — delivered ÷ attempted over a rolling window, derived from `outreach_log` advance +
  `handleBounce` outcomes (aggregate counts, never recipients), with a target band.
- **Tracking-ingestion lag** — the age of the oldest un-processed row in the partitioned **`email_event`**
  store (the D11 raw open/click/bounce/complaint store that feeds `activities`) — the signal that webhook
  ingestion is keeping up.
- **Provider latency SLOs** — p95 enqueue→accepted latency per ESP / mailbox provider (cross-ref the §3.1
  routing), and the per-provider error rate — so a degraded ESP is visible as a provider SLO breach, not a
  mystery.
- **Service status row** — the existing page reports `api`/`database` up and `workers`/`redis`/`search`
  `unknown` honestly (`routes.ts` lines 130–138, *"do not fabricate green checks"*); the email worker fleet
  joins that row under the same honesty rule.

**Primary actions.** Read-only monitoring + drill-through: from a breaching email SLO, jump to the affected
tenant's deliverability page (§3.6) or sending-domain panel (§3.5). Remediation (pause/quarantine) lives in
§3.6, not here.

**Role gating.** Read for `super_admin`, `support`, `read_only` — the existing page is behind the coarse
`platformAdmin` gate with no extra staff-role narrowing (`routes.ts` lines 118–119), and the email SLOs
inherit that. Aggregate-only.

| Field | Value |
|---|---|
| **Maps onto** | **System health** `/system-health` (`apps/admin/src/features/system-health/`) → `routes.ts` `/system-health` — **extend the `sampleJobStatuses` proxy to the `email_*` queues** |
| **Purpose** | Email queue depth, send success rate, tracking-ingestion lag, provider latency SLOs + DLQ (D10) |
| **Key elements** | `email_*` queue depth/DLQ (existing tally extended); send success rate; `email_event` ingestion lag; per-provider p95 latency + error rate; honest service-status row |
| **Primary actions** | Monitor; drill from a breaching SLO into the affected tenant's deliverability/domain panel |
| **Who can access** | `super_admin`, `support`, `read_only` (read) |

---

### 3.4 Compliance & Audit (email scope) — extend the **Audit log** page

**Purpose.** The compliance officer's console for the email subsystem — **a privacy-safe audit-log viewer,
DSAR cascade tracking, and `consent_records` lookup** — realizing **D9 (compliance enforced)**. It is **not
a new viewer**: the platform **Audit log** page already ships at `apps/admin/src/features/audit-log/` backed
by `apps/api/src/features/admin/auditLog.ts` (super_admin / compliance_officer gated). M12 extends it with
the email-scoped action filter and DSAR cascade from `06-compliance.md`. Enterprise privacy programs treat
exactly this — automated DSAR handling, ROPA, **immutable audit trails** — as essential operational
infrastructure ([OneTrust/DataGrail/Transcend class](https://secureprivacy.ai/blog/what-are-dsar-tools);
[GDPR↔SOC2 unified evidence](https://sprinto.com/blog/soc-2-vs-gdpr/)).

**Key elements.**
- **Audit-log viewer filtered to email actions — IDs + actions ONLY, never PII or body.** The shipped
  `audit_log.action` is a **closed enum** that already includes **`send` / `enroll` / `unsubscribe` /
  `suppression.add` / `suppression.remove`** (`00-overview.md` §5.1; `packages/db/src/schema/billing.ts`).
  The email scope is a **filter over the existing rows**, not a new table — actor, action, target tenant,
  time. The row carries IDs + metadata, **no recipient address, no rendered email body** (the hard rule from
  `06-compliance.md` and `list-plan/07 §5`). The trail is **append-only** (UPDATE/DELETE raise for every
  role) and reading it is *itself* audited. Cursor-paginated + virtualized.
- **DSAR cascade tracking** — intake → identity-link → **cascade tracker** over the **reused** entities a
  subject's request touches: `consent_records` (withdraw), `outreach_log` (dis-enroll from unsent steps),
  `suppression_list` (block re-contact), and the raw `email_event` references. On erasure the cascade writes
  a **`suppression_list` row with `scope = global`** to block re-contact — reusing the existing
  `dsar_requests` cascade pattern (`packages/core` + `apps/workers/src/queues/dsar.ts`), not a new mechanism
  (**D9**; contract owned by `06-compliance.md`; mirrors `list-plan/07 §6`).
- **`consent_records` lookup** — the *fact and provenance* of consent for a subject/tenant (`lawful_basis`,
  `valid_from` / `valid_until` / `withdrawn_at`, source) — **state, not message content** (the real
  `consent_records` table, `packages/db/src/schema/compliance.ts`; **never** an `email_consent` table — D11).
- **Auditor export** — a bounded, audited export of an audit slice (IDs+actions) for a SOC 2 / GDPR auditor.

**Primary actions.** Filter/read the email-scoped audit trail; run and track a DSAR cascade; read consent
state; export an audit slice. All DSAR **writes** run through the privileged DSAR fan-out
(`apps/workers/src/queues/dsar.ts`, `leadwolf_admin`), separately audited — a legally-mandated path, not
casual access (`06`, `list-plan/07 §3.1`).

**Role gating.** **`compliance_officer` and `super_admin` only** — matching the existing
`auditLog.ts` gate. `support`/`billing_ops`/`read_only` do not operate DSAR or read the audit trail.

| Field | Value |
|---|---|
| **Maps onto** | **Audit log** `/audit-log` (`apps/admin/src/features/audit-log/`) → `apps/api/src/features/admin/auditLog.ts` — **filter the existing viewer to email actions; reuse the `dsar_requests` cascade** |
| **Purpose** | Privacy-safe audit viewer + DSAR tooling + `consent_records` lookup for email (D9; cross-ref `06`) |
| **Key elements** | `audit_log` rows filtered to `send`/`enroll`/`unsubscribe`/`suppression.*` (IDs+actions only, append-only); DSAR cascade over `consent_records`/`outreach_log`/`suppression_list`/`email_event` (writes `scope=global` suppression on erase); `consent_records` state lookup |
| **Primary actions** | Filter/read email audit; run/track DSAR cascade; read consent state; export audit slice (DSAR writes via privileged fan-out) |
| **Who can access** | `compliance_officer`, `super_admin` |

---

### 3.5 Sending-Domain management + DNS-auth state — **NEW page**

**Purpose.** Give platform-staff a cross-tenant view of the **sending identity + connection layer** — every
**`sending_domain`** a tenant owns and every **`mailbox_integration`** it has connected — so support can
diagnose a "my email won't send" ticket and an admin can see, at a glance, which tenants are
mis-authenticated (SPF/DKIM/DMARC failing) and therefore a deliverability risk to shared infrastructure.
**This is one of the three genuinely-new pages (D11)**, because `sending_domain` and `mailbox_integration`
are the genuinely-new M12 entities — there is no existing admin surface for them. It is the internal
counterpart to the tenant's own mailbox/domain settings in `10-web-surface.md`; the admin sees the **same
state, across all tenants, read-mostly**.

**Key elements.**
- **Per-tenant `mailbox_integration` list** — one row per mailbox: provider (Gmail/M365/SMTP/ESP), owner
  (`owner_user_id`), connection status (connected / token-expired / disconnected / error), last-send
  timestamp, daily-send count (aggregate, not recipients). Cursor-paginated + virtualized across a tenant's
  mailboxes and across tenants. **No credential is ever rendered** — the row shows
  *connected-with-provider-X*, never the OAuth refresh token or SMTP password (D7; same `keyHint` discipline
  as §3.1 / `providerConfigs.ts` line 59).
- **`sending_domain` DNS-auth panel** — per domain: SPF, DKIM, DMARC each shown as **pass / fail / pending**
  with the *expected vs observed* record — the diagnostic detail deliverability ops consoles standardize on
  (continuous SPF/DKIM/DMARC validation plus instant alerts when a record breaks —
  [GlockApps](https://glockapps.com/); [Mailtrap deliverability tools, 2026](https://mailtrap.io/blog/email-deliverability-tools/)).
- **Custom tracking-domain (D3) CNAME status** — per tenant: the `track.<tenant-subdomain>` CNAME target and
  its resolve/verify state, since open/click tracking and link rewriting depend on it.
- **Verification rollup** — a single badge ("domain verified & authenticated" vs "action needed") so the
  fleet view sorts at-risk tenants to the top.

**Primary actions.**
- **Re-trigger a DNS recheck** for a tenant's `sending_domain` (queues a verify job; D10 queue-backed) —
  audited `admin.email.domain.recheck`.
- **Force re-verify / mark a `mailbox_integration` disconnected** when a tenant's token is wedged and
  support needs to prompt a reconnect — audited `admin.email.mailbox.disconnect`. The admin **cannot** see or
  extract the secret (D7).
- **Open the tenant's reputation pool** (§3.6) from a domain row, linking domain-auth state to
  deliverability.

**Role gating.** Read for all staff tiers including `read_only`/`compliance_officer`; **act**
(recheck/disconnect) for `super_admin` and `support`. No tier sees secrets. New page at
`apps/admin/src/features/sending-domains/` → **new** `apps/api/src/features/admin/email/domains.ts` mounted
on `adminRoutes` (inheriting the `authn` + `platformAdmin` chain, `routes.ts` lines 36–37), with read shapes
in a `@leadwolf/db` `emailAdminRepository` extension read via `withPlatformTx`.

| Field | Value |
|---|---|
| **Maps onto** | **NEW** page `apps/admin/src/features/sending-domains/` → **NEW** `apps/api/src/features/admin/email/domains.ts` (genuinely-new: `sending_domain` + `mailbox_integration` are new M12 entities, D11) |
| **Purpose** | Cross-tenant view + repair of the `sending_domain`/`mailbox_integration` connection layer; surface DNS-auth risk |
| **Key elements** | Per-tenant `mailbox_integration` list (no secrets, D7); SPF/DKIM/DMARC panel; D3 tracking-CNAME state; verification rollup |
| **Primary actions** | DNS recheck; force re-verify; mark mailbox disconnected; open reputation pool. **Never** reveal secrets (D7) |
| **Who can access** | `super_admin`, `support` (act); `read_only`, `compliance_officer` (read) |

---

### 3.6 Per-tenant deliverability monitoring + reputation/quota controls — **NEW page**

**Purpose.** Continuous, **per-tenant** deliverability health plus the **reputation/quota control room** —
the lens on **D2 (per-tenant reputation isolation)** and the FinOps/abuse guardrails. **This is the second
genuinely-new page (D11)**; the per-tenant *limits* portion also surfaces as a **tab on the existing Tenants
detail page** (`apps/admin/src/features/tenants/`, which already shows plan/status/seats/credits per
`routes.ts` lines 58–77). Continuous monitoring is the explicit value modern consoles sell ("continuous
monitoring is what separates teams that maintain 90%+ inbox rates from those who discover problems after
their pipeline has dried up" — [Instantly, 2026](https://instantly.ai/blog/how-to-achieve-90-cold-email-deliverability-in-2025/)),
and per-tenant auto-pause is exactly the SES model ("if reputation issues are detected, SES can
automatically pause the affected tenant to protect other email streams," Standard/Strict levels —
[AWS SES, Aug 2025](https://aws.amazon.com/about-aws/whats-new/2025/08/amazon-ses-tenant-isolation-automated-reputation-policies/);
[StackPioneers, Aug 2025](https://stackpioneers.com/2025/08/02/comprehensive-guide-to-amazon-ses-tenant-isolation-and-reputation-policies/)).
Detail and thresholds are owned by `03-deliverability.md` and `07-multitenancy-reputation-isolation.md`. It
tracks mainly in **P5** of the phase map (`13`), ahead of the broader P6 admin build, because deliverability
is the first cross-tenant risk that goes live with sending.

**Key elements.**
- **Per-tenant deliverability scorecard** — inbox-placement %, complaint rate, bounce rate (hard/soft),
  spam-folder rate, derived from the **`email_event`** raw store + `activities` **aggregates** (never
  per-recipient rows). **D6: opens are informational, not a KPI** — the scorecard treats inbox-placement and
  reply/complaint signals as primary and labels opens advisory.
- **Seed / inbox-placement tests** — admin-triggered placement runs across Gmail/Outlook/etc.
  ([GlockApps](https://glockapps.com/); [Mailtrap, 2026](https://mailtrap.io/blog/email-deliverability-tools/)).
- **Blacklist watchlist** — per `sending_domain` / IP, current listing status with **instant blacklist
  alerts** ([Warmforge](https://www.warmforge.ai/blog/blacklist-monitoring-email-deliverability)).
- **Reputation-pool view (D2)** — the tenant's `sending_domain` + `mailbox_integration` set (+ optional
  dedicated IP) as a single isolation unit, with its current standing.
- **Per-tenant send-quota / hard-cap / per-user-limit editor** — the per-tenant outbound counter built on
  the **shipped `creditRepository` `SELECT … FOR UPDATE` no-overdraft lock pattern (ADR-0007)** — *a new
  counter, the same lock template, not a new mechanism* (D11). **Known gap (track it):** the per-tenant send
  quota gates are a P6 build item (`13`); until wired, the UI must label any unwired control as
  not-yet-enforcing rather than imply a guarantee it does not have.
- **Complaint-rate circuit breaker + quarantine** — per-tenant state (armed/tripped); tripping
  **auto-pauses** that tenant's sending (Standard vs Strict, per `07`); quarantine **halts the reputation
  pool** while leaving data intact and the tenant notified.

**Primary actions.** Trigger a seed/placement test; acknowledge/snooze a blacklist alert; **edit quota / hard
cap / per-user limit**; **arm/disarm** the circuit breaker; **pause / quarantine** a tenant's sending and
**lift** it. Every action is audited (`admin.email.deliverability.test`, `admin.email.quota.set`,
`admin.email.circuit.trip`, `admin.email.quarantine` / `.unquarantine`) via `withPlatformTx`, and the tenant
is notified — there is no silent throttle.

**Role gating.** `super_admin` writes all controls; **`support` may pause/quarantine on confirmed abuse**
(the incident lever) but not edit quotas; `read_only` reads. `billing_ops` sees the *numbers* via §4, not the
controls. New page at `apps/admin/src/features/deliverability/` → **new**
`apps/api/src/features/admin/email/deliverability.ts`, with the limits tab reusing the existing
`apps/admin/src/features/tenants/` detail shell.

| Field | Value |
|---|---|
| **Maps onto** | **NEW** page `apps/admin/src/features/deliverability/` (+ a limits tab on the existing **Tenants** detail) → **NEW** `apps/api/src/features/admin/email/deliverability.ts` |
| **Purpose** | Per-tenant deliverability health + D2 isolation + FinOps/abuse guardrails: scorecard, quota/cap/per-user, circuit breaker, quarantine (cross-ref `03`, `07`) |
| **Key elements** | Scorecard from `email_event`+`activities` aggregates (D6 opens advisory); seed/placement tests; blacklist watchlist; reputation-pool (D2) view; send-quota editor (`creditRepository` lock; gate-wiring is a known gap — label clearly); circuit breaker; quarantine |
| **Primary actions** | Run placement test; ack blacklist alert; edit limits; arm/disarm breaker; pause/quarantine + lift (audited; tenant notified) |
| **Who can access** | `super_admin` (write); `support` (pause/quarantine on abuse); `read_only` (read) |

---

### 3.7 Global suppression — **NEW page**

**Purpose.** A **platform-wide** suppression list, **distinct from per-tenant suppression**, that blocks an
address/domain across *every* tenant — for confirmed spam-traps, role accounts we never mail, regulator
demands, and addresses that complained against the platform. **This is the third genuinely-new page (D11)**
— there is no existing admin surface for it, but it is **not a new table**: it is the **`scope = global`**
tier of the **shipped `suppression_list`** (`packages/db/src/schema/billing.ts`), and per **D4 it gates
every send** in-transaction through the **shipped `assertNotSuppressed`** gate (the unbypassable gate that
already runs in the reveal AND send tx — `packages/core/src/compliance/assertNotSuppressed.ts`; **never** a
new `email_suppression` table). Subscribing to all feedback loops and **never re-adding a complainant without
explicit reconfirmation** is the discipline multi-tenant ESPs codify
([MailChannels, 2026](https://www.mailchannels.com/multi-tenant-email-deliverability/)).

**Key elements.**
- **Global suppression list** — `suppression_list` rows with `scope = global`: the **blind-indexed key**
  (`email_blind_index` / `domain` / `phone_blind_index` — never plaintext at rest), `match_type`, `reason`,
  source (FBL / manual / regulator / spam-trap), `created_by_user_id`, `created_at`. Cursor-paginated +
  virtualized (this list grows large).
- **Reason / source taxonomy** so an admin can later justify and, where lawful, reverse a global block.
- **"Which sends did this block"** trace — an aggregate count of suppressed-at-send events for a key (counts,
  not recipient identities), so an admin can gauge impact before removing a global entry.

**Primary actions.** Add / remove a single global suppression; **bulk-import** a global block-list
(queue-backed, D10, audited); trace a key's block impact. All writes are audited via the shipped
`audit_log` `suppression.add` / `suppression.remove` actions (`00-overview.md` §5.1); removal of a
complaint-origin entry should require a senior-role confirmation (do not silently un-suppress a complainant).

**Role gating.** **`compliance_officer` and `super_admin` only** — global suppression affects every tenant's
deliverability and a wrong entry blocks legitimate mail platform-wide. `support`/`billing_ops`/`read_only`
do not write here. New page at `apps/admin/src/features/global-suppression/` → **new**
`apps/api/src/features/admin/email/suppression.ts`, writing the `scope = global` rows through
`withPlatformTx`.

| Field | Value |
|---|---|
| **Maps onto** | **NEW** page `apps/admin/src/features/global-suppression/` → **NEW** `apps/api/src/features/admin/email/suppression.ts` (the `suppression_list` `scope=global` tier — reuses the shipped table + `assertNotSuppressed`, D4/D11) |
| **Purpose** | Platform-wide blocks distinct from tenant suppression; the `scope=global` tier that D4 gates every send against |
| **Key elements** | Global `suppression_list` rows (blind-indexed keys, never plaintext); reason/source taxonomy; per-key block-impact trace (counts only) |
| **Primary actions** | Add/remove global suppression; bulk-import (queue-backed, audited via `suppression.add`/`.remove`); trace block impact (un-suppress of complainant needs senior confirm) |
| **Who can access** | `compliance_officer`, `super_admin` |

---

## 4. Per-tenant email-volume billing — a tab on the existing **Tenants** page

Email-volume billing is **not a new page** — it is the FinOps lens on the **existing Tenants page**
(`apps/admin/src/features/tenants/` → `routes.ts` `/tenants`, which already shows plan / status / seats /
credits per org, lines 58–77). M12 adds **per-tenant send-volume + ESP-cost** to the tenant detail, alongside
the deliverability/quota tab (§3.6). Email is a **usage-metered** line item like SES/MailerSend volume
pricing, and the FinOps risk is the classic one — *sudden, unexpected usage spikes* — which is why per-tenant
metering and overage flags matter ([Schematic](https://schematichq.com/blog/metered-billing);
[Zenskar, 2026](https://www.zenskar.com/blog/metered-billing); [SES pricing, 2026](https://smtpedia.com/amazon-aws-ses-pricing/)).

- **Per-tenant send-volume + ESP-cost meter** — `outreach_log` send counts by period, mapped to provider unit
  cost (per the §3.1 routing), giving **cost-per-tenant**. **Aggregate-only** — counts/sums, never a recipient
  row (the same privacy line as `list-plan/07 §7`).
- **Plan / quota-vs-usage** — each tenant's configured send-quota (§3.6) against actual consumption, with
  %-to-cap.
- **Cost-per-tenant trend + overage flags** — tenants trending over plan or showing an anomalous spike are
  flagged for review (the FinOps early-warning the operations skill requires; observability target = cost per
  tenant). The provider cost rollup reuses the **existing** `monthToDateCentsByProvider` aggregation
  (`providerConfigs.ts` lines 47–51), extended to ESP-send spend.

**Role gating.** Read for `billing_ops` and `super_admin`; the *act* of changing limits in response lives in
§3.6 (`super_admin`). `support`/`compliance_officer`/`read_only` are not billing roles here. Billing-ops is
**read on the money** — it reports aggregates; it does not change quotas and never reaches recipient data.

---

## 5. TruePoint grounding — where this lands and how it stays safe

- **App + API — extend, don't fork.** Email-admin capabilities map onto the **already-built**
  `apps/admin/src/features/{provider-configs, feature-flags, system-health, audit-log, tenants, users}`
  pages (§3.1–§3.4, §4) plus **three new feature folders** —
  `apps/admin/src/features/{sending-domains, deliverability, global-suppression}` (§3.5–§3.7). The API extends
  **`apps/api/src/features/admin/`**: §3.1–§3.4 reuse the shipped `providerConfigs.ts`, `routes.ts`
  feature-flags + system-health, and `auditLog.ts` endpoints; §3.5–§3.7 add a new `email/` route group
  (`domains.ts` / `deliverability.ts` / `suppression.ts`) mounted on `adminRoutes`, inheriting the existing
  `authn` + `platformAdmin` chain (`routes.ts` lines 36–37) and adding `requireStaffRole(...)` per section.
  Read shapes live in a `@leadwolf/db` `emailAdminRepository` extension; cross-tenant reads use
  **`withPlatformTx`**, are **bounded** (`PLATFORM_READ_LIMIT`), and are **audited in-transaction**.
- **Reuse, not duplication (D11).** No email-admin surface introduces a parallel `email_sequence` /
  `email_sequence_step` / `email_enrollment` / `email_suppression` / `email_consent` /
  `email_idempotency_key` table. Suppression is
  the **`suppression_list`** `scope=global` tier behind the shipped **`assertNotSuppressed`** gate; consent is
  **`consent_records`**; the audit trail is the shipped **`audit_log`**; the send-quota is a new counter on
  the **`creditRepository`** lock pattern. The only genuinely-new entities the console reads are
  **`sending_domain`**, **`mailbox_integration`**, and the partitioned raw **`email_event`** store.
- **Cross-tenant access is the audited `leadwolf_admin` path.** No email-admin endpoint reaches tenant data
  except through `withPlatformTx` (metadata/aggregate) or **break-glass impersonation** (record-level — the
  existing `apps/admin` Users page + `apps/api/src/features/admin/impersonation.ts`, time-boxed + audited).
  Every privileged read/write writes a `platform_audit_log` row; the audit table is append-only and reading
  it is itself audited.
- **Contract.** `/api/v1`; Zod schemas in `@leadwolf/types`; **cursor pagination** on every list; RFC 9457
  error envelope; **Idempotency-Key** on admin writes (D5 — rechecks/imports are idempotent). Fan-out and
  imports are **queue-backed** (D10); System health (§3.3) shows queue depth / running / failed / **DLQ**.
- **Frontend pattern.** Vanilla React + `fetchWithAuth` + `MaybeList` + `StateSwitch` + `DataTable` from
  `@leadwolf/ui` (ADR-0016) — the exact pattern of every shipped admin feature
  (`features/provider-configs/`, `features/system-health/`). **No TanStack Query / `useQuery` / query-keys.**
- **Security final say.** Platform-staff is the highest privilege; **secrets are never rendered** (D7 — the
  shipped `keyHint: null` discipline, `providerConfigs.ts` line 59); audit rows carry **IDs + actions, never
  PII or bodies**; deliverability and billing are **aggregate-only**. Mutations are step-up + senior-role
  gated (`requireStaffRole`, the same gate `providerConfigs.ts` line 32 already applies). These are
  boundaries, not UI conventions — UI hiding is never the control (`list-plan/07 §1`).
- **Known gaps this surface must track (constraints digest):** **KMS not yet done** (§3.1/§3.5 show redacted
  `keyHint` refs and must not imply hardware-backed secrecy yet — matching the existing `// WIRE` note);
  **per-tenant send-quota gates UNWIRED** (§3.6 controls exist before enforcement — label clearly);
  **no per-endpoint cross-tenant HTTP isolation test** for the new email-admin routes (they need the
  isolation itest from `list-plan/07 §8`); **residency siloing absent** (§3.1 ESP-account region is a field
  today, not an enforced boundary); **confirm leader-locked scheduler** for the fan-out the console observes.

---

## 6. Cross-references

- **`00-overview.md`** — D1–D11 Locked Decisions, the Shared Vocabulary (real table/code names) used
  verbatim throughout, and §5.1 (the shipped admin console this doc extends).
- **`03-deliverability.md`** — the deliverability metrics (inbox-placement, blacklist, complaint/bounce) that
  §3.6's admin scorecard renders.
- **`06-compliance.md`** — the `audit_log` shape (IDs+actions, no PII/body), the DSAR cascade over reused
  entities, and `consent_records` semantics that §3.4 operationalizes; the suppression-gate contract behind
  §3.7.
- **`07-multitenancy-reputation-isolation.md`** — the reputation-pool (D2) model, quota/cap/per-user limits,
  complaint-rate circuit breaker, and quarantine that §3.6 controls; the per-tenant vs global suppression
  split behind §3.7.
- **`09-data-model.md`** — owns the canonical entities the new pages read (`sending_domain`,
  `mailbox_integration`, the partitioned `email_event` store) and the reused ones (`suppression_list`,
  `consent_records`, `audit_log`, `outreach_log`, `activities`).
- **`10-web-surface.md`** — the customer-facing mirror of §3.5; the admin surfaces here are the cross-tenant
  internal counterpart, never tenant-visible.
- **`12-roles-permissions.md`** — the authoritative `requireStaffRole(...)` tier definitions
  (`super_admin` / `support` / `billing_ops` / `compliance_officer` / `read_only`) used in every "who can
  access" cell above; break-glass = the existing `apps/admin` Users impersonation.
- **`13-rollout-phases.md`** — these surfaces land mainly in **P6 Admin + governance**; deliverability
  monitoring (§3.6) tracks **P5**.
- **`14-current-state-integration.md`** — the authoritative D11 reuse map: the shipped admin console
  (Tenants / Users / Providers / Feature flags / Staff / Audit log / System health) and exactly how the
  email panels extend each.
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
