# Email Subsystem — Data Model, RLS, Isolation Guarantee & DSAR Cascade (09)

> **Status:** Plan (not yet built — but most of it already exists). **Owner:** Data + Platform.
> **Last updated:** 2026-06-24.
> This is the **canonical schema** document for the `docs/planning/email-planning/` set. It **OWNS the
> entity catalog** named in `00-overview.md §4` — every other doc references these entities **by their
> real table name and by column**, and none may redefine them. It cites the **Locked Decisions (D1–D11)**,
> the **Shared Vocabulary**, and the **Phase Map (P0–P6)** from `00-overview.md`.
>
> **This is M12 — it EXTENDS the shipped M9 outreach engine; it is NOT a greenfield schema (D11).**
> The sequence/step/enrollment tables, the suppression list, consent records, idempotency keys, the
> audit log, and the engagement timeline **already exist and ship today**. This doc's job is to (a) state
> the **real existing tables as the source of truth**, (b) list the **small set of columns the email
> subsystem ADDS** to them, and (c) **fully define the genuinely-new tables** — `sending_domain`,
> `mailbox_integration`, `email_event`, and the per-tenant send-quota counter. There are **no parallel
> `email_sequence` / `email_sequence_step` / `email_enrollment` / `email_suppression` / `email_consent`
> / `email_idempotency_key` tables** — those names are mapped onto the real `outreach_*` / `suppression_list`
> / `consent_records` / `idempotency_keys` tables per **D11** and the §0 vocabulary mapping.
>
> **Scope:** the `packages/db` + `@leadwolf/types` slice — the new schema unit, RLS, the new repositories,
> the isolation itest, and the DSAR cascade. The send path is `02`; templating is `01`; tracking is `04`;
> sequences are `05`; compliance is `06`; the isolation guarantee in depth is `07`; the surfaces are `10`
> / `11`; integration with the shipped engine is `14`. Where this doc names a column or constraint a
> sibling relies on, **the sibling defers to this doc**.
>
> **Convention (matches `list-plan/02-data-model.md`):** plain English + real schema/table/column names
> with `file.ts:line` cites for what exists; no migrations or TypeScript bodies; one tiny illustrative RLS
> snippet (the List-tab data model does the same). External citations appear only where a schema-pattern
> claim is made.

---

## 0. The vocabulary mapping (read this before any column) — D11

Every "email" concept in `00 §4`'s glossary is a **real, shipped table**, not a new one. Use the real
name verbatim everywhere downstream.

| Glossary term (`00 §4`) | **Real table — source of truth** | Where it lives | Status |
|---|---|---|---|
| Sequence (Cadence) | **`outreach_sequences`** | `packages/db/src/schema/outreach.ts:36` | **exists (M9)** |
| Step | **`outreach_steps`** | `outreach.ts:60` | **exists (M9)** |
| Enrollment | **`outreach_log`** | `outreach.ts:85` | **exists (M9)** |
| Send transaction | **`packages/core/src/outreach/sendStep.ts`** | core/outreach | **exists (M9)** |
| Bounce handling | **`packages/core/src/outreach/handleBounce.ts`** | core/outreach | **exists (M9)** |
| Sender seam | **`EmailSenderPort`** (`outreach/senderPort.ts`) | core/outreach | **exists (M9)** |
| Tracking / engagement timeline | **`activities`** (+ raw **`email_event`** store, NEW) | `activity.ts:23` | **exists (M8)** + NEW |
| Suppression | **`suppression_list`** | `billing.ts:111` | **exists (M5)** |
| Consent | **`consent_records`** | `compliance.ts:15` | **exists (M5)** |
| Idempotency | **`idempotency_keys`** | `billing.ts:152` | **exists (M3)** |
| Audit | **`audit_log`** | `billing.ts:169` | **exists (M3)** |
| Person | **`contacts`** | `contacts.ts:92` | **exists (M1)** |
| Template | **`outreach_steps.subject` / `.body`** today; a versioned template table is roadmap (`01`) | `outreach.ts:60` | exists (inline) |
| **Mailbox** | **`mailbox_integration`** | `schema/email.ts` (NEW) | **NEW (M12)** |
| **Sending Domain** | **`sending_domain`** | `schema/email.ts` (NEW) | **NEW (M12)** |
| **Tracking Event (raw)** | **`email_event`** | `schema/email.ts` (NEW) | **NEW (M12)** |
| **Send Quota** | **per-tenant counter on `tenants`** (reuse the `creditRepository` lock pattern) | `auth.ts` / `creditRepository.ts` | **NEW (M12)** |

> **The four genuinely-new tables (the whole §3 build):** `sending_domain`, `mailbox_integration`,
> `email_event`, and the send-quota counter. Everything else in this doc is the **existing** schema
> restated as the contract, plus the **few additive columns** (§2) the email layer needs on the existing
> tables. **A multi-tenant write without an RLS-enforced, ownership-checked path is a bug, not a style
> choice** — and that path already exists for the reused tables; the new tables inherit the same posture.

---

## 1. Where this lands in the codebase (the file contract)

The reused tables (`outreach_*`, `suppression_list`, `consent_records`, `idempotency_keys`, `audit_log`,
`activities`, `contacts`) already have their schema, RLS, repositories, and isolation tests. The email
subsystem adds **one new schema unit and its companions** for the genuinely-new tables, plus a handful of
**additive columns** on the existing schema files (§2):

| File | Role |
|---|---|
| `packages/db/src/schema/email.ts` | **New.** Drizzle schema for the genuinely-new tables only — `sending_domain`, `mailbox_integration`, `email_event` (§3). One cohesive unit, like `contacts.ts`. Reuses the local column-factory idioms (`id()`, `tenantId()`, `workspaceId()`, `createdAt()`, `updatedAt()`) and the `bytea` / `citext` `customType` helpers. **No** sequence/step/enrollment/suppression/consent/idempotency tables — those are reused. |
| `packages/db/src/schema/outreach.ts` | **Edited (additive).** `outreach_steps` gains a template ref + variant weight; `outreach_log` gains a delivery-status cache (§2). All nullable/defaulted → non-destructive migration. |
| `packages/db/src/rls/email.sql` | **New.** Idempotent RLS file for the new tables: `ENABLE` + `FORCE ROW LEVEL SECURITY`, one `*_workspace_isolation` (or `*_tenant_isolation`) policy each, the shared `set_updated_at()` triggers, the partition-management for `email_event`, and the closing `GRANT` to `leadwolf_app`. Applied by `applyMigrations` in the sorted `rls/*.sql` pass (the existing `rls/outreach.sql` / `rls/billing.sql` / `rls/compliance.sql` are unchanged). |
| `packages/db/src/repositories/emailRepository.ts` | **New.** The sole data-access layer for `sending_domain` / `mailbox_integration` / `email_event` rows. Every method is `tx`-aware (composed inside one `withTenantTx` by `packages/core/src/email/`), so RLS scopes every read/write. Secret columns are **projected out of every DTO** (D7). |
| `packages/db/src/repositories/sendQuotaRepository.ts` | **New.** The per-tenant send-quota counter — **the `creditRepository` `SELECT … FOR UPDATE` pattern** (`creditRepository.ts:30`), a separate counter from `reveal_credit_balance` (§3.4). |
| `packages/db/src/test/email.itest.ts` | **New.** The mandatory **two-tenant cross-tenant isolation itest** (§7) for the new tables, modelled on `savedSearches.itest.ts` / the List tab's `lists.itest.ts`. |
| `packages/core/src/email/` | **New.** Framework-free domain logic (domain verification, mailbox connect, event ingestion → `activities` fan-out, quota check) — calls the repositories, never the DB directly. Composes the **existing** `core/outreach/sendStep` + `assertNotSuppressed` rather than re-implementing them. |
| `packages/types/src/email.ts` | **New.** The Zod source of truth for the new closed enums and DTOs (§5); the `check()` enums in `email.ts` **mirror** this file (the `outreach.ts:4` idiom). The reused tables keep their existing types in `types/src/{outreach,billing,activity,compliance}.ts`. |

**References, not copies (the data rule).** Every new email row that "is about" a Person or a Send stores
**only the foreign-key id** of the canonical row — never a snapshot. An `email_event` references the
canonical **Person** (`contacts.id`) and the **send** it concerns (the `outreach_log` enrollment + a
`message_id`) **by id / by external id**; it does not copy the Person's address, the message body, or the
template into the event row. `mailbox_integration` and `sending_domain` are tenant infrastructure rows,
not data-subject records.

---

## 2. Existing tables = the source of truth (real columns + what email ADDS)

This is the analogue of `list-plan/02 §1` ("What exists today — the backend is already built"). For each
reused table: the **real columns that ship today**, then the **only** columns the email subsystem adds.
Nothing here is a new table; every addition is **nullable or defaulted** so the migration is
non-destructive (the `list-plan/02 §2` discipline).

### 2.1 `outreach_sequences` — the cadence definition (`outreach.ts:36`)

**Ships today.** `id`, `tenant_id` (FK `tenants` CASCADE), `workspace_id` (FK `workspaces` CASCADE),
`name`, `status` ∈ `{active,paused,archived}`, `from_address` (CAN-SPAM truthful From — **nullable here,
enforced at the send tx**, `outreach.ts:44`), `physical_address` (CAN-SPAM postal — same posture),
`created_by_user_id`, `created_at`, `updated_at`. **`UNIQUE(workspace_id, name)`** (`outreach.ts:51`).

**Email subsystem adds:** **nothing structural.** The CAN-SPAM identity fields and the per-workspace
uniqueness are already exactly what `06` / `02` require. (Mailbox-rotation strategy and per-sequence
quota policy are **app-layer config / `mailbox_integration` rows**, not new columns here — `02`/`05`.)

### 2.2 `outreach_steps` — the ordered step (`outreach.ts:60`)

**Ships today.** `id`, `tenant_id`, `workspace_id`, `sequence_id` (FK `outreach_sequences` CASCADE),
`step_order`, `channel` ∈ `{email,linkedin}` (default `email`), `delay_hours` (`>= 0` check,
`outreach.ts:77`), `subject`, `body` (the inline template content today), `created_at`.
**`UNIQUE(sequence_id, step_order)`** (`outreach.ts:75`).

**Email subsystem ADDS (additive, nullable):**

- `template_version_id` (`uuid`, nullable, FK → the versioned-template table `01` introduces, **SET NULL**)
  — a step references a reusable **template by id, not copies it**. Until templating ships, `subject`/`body`
  remain the inline source; once it ships, a non-null `template_version_id` takes precedence at render time
  (`01`). **Never a string copy of another step's body.**
- `variant_weight` (`integer`, nullable, default 100) — the A/B variant weight for a step (multiple steps
  at the same `step_order` form a variant group; the scheduler picks by weight). Nullable so existing
  single-variant steps are unaffected; `>= 0` check.

These are the **only** two columns added to `outreach_steps`. No new step table.

### 2.3 `outreach_log` — the enrollment (`outreach.ts:85`)

**Ships today.** `id`, `tenant_id`, `workspace_id`, `sequence_id` (FK CASCADE), `contact_id`
(FK `contacts.id` CASCADE — the **Person**), `status` ∈
`{enrolled,active,replied,completed,unsubscribed,bounced}`, `current_step`, `last_event_at`, `created_at`.
**`UNIQUE(sequence_id, contact_id)` = the enrollment-idempotency key** (`outreach.ts:101`). Targeted for
**monthly range-partitioning** when volume warrants (the `outreach.ts:84` note — do not drop the intent).

**Email subsystem ADDS (additive, nullable):**

- `last_delivery_status` (`varchar(20)`, nullable) — a **denormalized cache** of the most recent terminal
  delivery state for this enrollment (`delivered|bounced|complained|failed`), populated by the
  `email_event` → `activities` ingestion path (§3.3) so the Sequences dashboard (`08`) and the auto-pause
  logic (`05`, **D9**) read it without a per-row scan of `email_event`. **A cache, not the system of
  record** — the raw truth is `email_event`; the timeline of record is `activities`.
- `next_run_at` (`timestamptz`, nullable) — the scheduler cursor for the sequence-tick queue
  (`email_sequence_tick`, **D10**), set by the leader-locked tick (`05`, the confirm-leader-locked-scheduler
  **known gap**). Nullable so a non-scheduled enrollment carries none. (If the shipped engine already
  schedules via a different mechanism, `14` reconciles; this column is the proposed cursor.)

No new enrollment table — `outreach_log` **is** the enrollment, including its idempotency key.

### 2.4 `activities` — the engagement timeline (`activity.ts:23`)

**Ships today.** `id`, `tenant_id`, `workspace_id`, `contact_id` (FK CASCADE), `actor_user_id`
(nullable — null = system/send engine), `activity_type` (incl. **`email_sent`, `email_opened`,
`email_clicked`, `email_replied`**, `activity.ts:49`), `channel` ∈
`{email,phone,linkedin,sales_navigator,in-person}`, `outcome`, `note`, `metadata` (jsonb), `occurred_at`.
Index `idx_activities_ws_contact_occurred` `(workspace_id, contact_id, occurred_at DESC)` (`activity.ts:42`).
`contacts.last_activity_at` is a trigger-maintained cache of the newest `occurred_at` (`activity.ts:3`).

**Email subsystem ADDS:** **no columns.** The engagement timeline of record stays `activities`. The email
layer **uses the existing `metadata` jsonb** to carry the email-specific facts the timeline needs:

- `metadata.messageId` — the provider/ESP/mailbox message id (correlation to `email_event`).
- `metadata.deliveryStatus` — the delivery state at the time the activity row was written.
- `metadata.eventId` — the `email_event.id` this activity was derived from (provenance; lets the ingestion
  path stay idempotent — re-deriving the same event is a no-op).
- `metadata.isMppSuspected` — carried from `email_event` so reporting (`08`, **D6**) can de-emphasize
  Apple-MPP-prefetched opens.

`metadata` carries **non-PII only** (ids, status, class) — never the recipient address or the message body
(the audit/PII posture, `00 §5`). The email-event activity types already exist; **no enum change is
needed**.

### 2.5 `suppression_list` — the fail-closed do-not-send gate (`billing.ts:111`, **D4**)

**Ships today.** `id`, `scope` ∈ `{global,tenant,workspace}`, `tenant_id` (nullable on global rows),
`workspace_id` (nullable on tenant/global rows), `match_type` ∈ `{email,domain,phone,contact_id}`,
`email_blind_index` (`bytea` HMAC — matches `contacts.email_blind_index`), `domain` (citext),
`phone_blind_index` (`bytea`), `contact_id` (FK `contacts.id` CASCADE), `reason`, `created_by_user_id`,
`created_at`. Two coherence checks ship: **`suppression_scope_coherence`** (global rows carry no
tenant/workspace; workspace rows carry both — `billing.ts:134`) and **`suppression_match_key_present`**
(the column named by `match_type` is non-null — `billing.ts:141`). Checked **in-tx on every reveal AND
every send** via **`packages/core/src/compliance/assertNotSuppressed.ts`** (the unbypassable **D4** gate).

**Email subsystem adds:** **nothing.** The scope model, the blind-index match, and the in-tx gate are
exactly what `06` requires. DSAR **adds rows** with `reason='dsar'` (and a `global`-scope row for
cross-tenant block, §8) — it never removes them. No `email_suppression` table exists.

### 2.6 `consent_records` — recorded lawful basis (`compliance.ts:15`, **D9**)

**Ships today.** `id`, `tenant_id`, `workspace_id`, `contact_id` (FK CASCADE), `jurisdiction` (ISO-2),
`lawful_basis` ∈ `{legitimate_interest,consent,contract,public_record}` (`compliance.ts:38`), `source`,
`valid_from`, `valid_until`, `withdrawn_at`, `recorded_by_user_id`, `created_at`.

**Email subsystem adds:** **nothing.** The send gate (`06`) consults this row alongside `suppression_list`;
a send lacking a valid basis / withdrawn is blocked. No `email_consent` table exists.

### 2.7 `idempotency_keys` — the stored-response replay store (`billing.ts:152`, **D5**)

**Ships today.** `id`, `tenant_id`, `key`, `response_status`, `response_body` (jsonb), `created_at`.
**`UNIQUE(tenant_id, key)`** (`billing.ts:163`).

**Email subsystem adds:** **nothing structural.** Every send create carries an `Idempotency-Key` and
reuses this table verbatim (**D5**) — the send route stores the response keyed `(tenant_id, key)`; a
replayed key returns the stored response, never a second send. (The reference back to the created send is
carried in the stored `response_body` as the send/enrollment id — no new column, no `email_idempotency_key`
table.)

### 2.8 `audit_log` — append-only audit (`billing.ts:169`)

**Ships today.** `id`, `tenant_id`, `workspace_id` (nullable = tenant-level), `actor_user_id`, `action`
(**CLOSED enum**, `billing.ts:187`), `entity_type`, `entity_id`, `metadata` (jsonb), `ip_address`,
`user_agent`, `origin_domain`, `occurred_at`. UPDATE/DELETE blocked by trigger in `rls/billing.sql`.
Index `idx_audit_log_tenant_occurred_at` `(tenant_id, occurred_at DESC)` (`billing.ts:215`).

**Email subsystem adds:** **no enum change.** The verbs the email layer needs already exist in the closed
enum: **`send`, `enroll`, `unsubscribe`, `suppression.add/remove`, `consent.record/withdraw`,
`dsar.access/delete/rectify`, `template.create/update/delete`, `sequence.create/update/delete`,
`credit.adjust`, `settings.update`** (`billing.ts:189–207`). Mailbox connect/disconnect and domain
verification audit as `settings.update` with the entity in `metadata` (or as new verbs **only if** added to
`types/src/billing.ts` first — the `billing.ts:186` mirror rule). **Audit stores ids + actions, never
secrets or message bodies** (**D7**, `00 §5`).

### 2.9 `contacts` — the canonical Person (`contacts.ts:92`)

**Ships today (email-relevant columns).** `id`, `tenant_id`, `workspace_id`, `owner_user_id` (soft owner,
**SET NULL** on user delete — a FILTER dimension, not an access wall, `contacts.ts:99`),
`outreach_status` ∈ `{new,in_sequence,replied,meeting_booked,disqualified,nurture,unsubscribed}`
(`contacts.ts:173` — the contact-level rollup, distinct from per-enrollment `outreach_log.status`),
`last_activity_at`, `email_enc` (`bytea` AES-GCM, masked until reveal), `email_blind_index` (`bytea` HMAC
— the per-workspace dedup + **the DSAR/suppression fan-out key**), `email_domain` (citext, non-PII facet),
`deleted_at` (the **DSAR tombstone**: set + PII nulled, `contacts.ts:147`).

**Email subsystem adds:** **nothing.** The Person is referenced by id from every email row; the
`email_blind_index` is the find-everywhere key the DSAR cascade matches on (§8); `deleted_at` is the
tombstone the cascade sets. **No new person table** — the email subsystem references `contacts.id`.

---

## 3. The genuinely-new tables (the full M12 build)

These four are the **only** new schema in the email subsystem. They land in
`packages/db/src/schema/email.ts` (the counter excepted — it is a column + counter on `tenants`), with RLS
in `packages/db/src/rls/email.sql`. All follow §4's conventions: `tenant_id` on every table; **RLS
`ENABLE` + `FORCE`, fail-closed `NULLIF`**; `tenant_id`-leading composite indexes; explicit dedup; a
**90-day default retention** + DSAR cascade; **references-not-copies** (events reference contacts/sends).

### 3.1 `sending_domain` — the tenant-authenticated sending domain (D2/D3)

- **Purpose.** A tenant-owned domain/subdomain authenticated for sending — SPF/DKIM/DMARC and the
  per-tenant custom tracking CNAME (`03`, **D2**, **D3**). The **reputation-isolation asset**: **no sending
  domain is ever shared across tenants** (**D2**), so this is the one **tenant-scoped** (not
  workspace-scoped) email entity.
- **Scope.** `tenant_id` (the RLS key — §4.2); `workspace_id` (**nullable** — a domain may be tenant-wide
  or pinned to a workspace).
- **Key columns.** `id`, `tenant_id` (FK `tenants` CASCADE), `workspace_id` (nullable, FK `workspaces`
  SET NULL), `domain` (`citext`), `status` ∈ `{pending,verifying,verified,failed,suspended}`,
  `spf_verified` (bool), `dkim_selector` (varchar), `dkim_verified` (bool),
  `dmarc_policy` ∈ `{none,quarantine,reject}`, `tracking_cname` (varchar — the per-tenant tracking host,
  **D3**), `reputation_state` ∈ `{unknown,healthy,at_risk,blocked}` (the rollup `03` maintains from
  bounce/complaint signals), `warmup_state` ∈ `{none,warming,complete}`, `dedicated_ip` (nullable —
  optional Reputation-Pool component, `00 §2` out-of-scope as a P0–P6 deliverable), `verified_at`
  (nullable), `created_at`, `updated_at`.
- **Uniqueness (the isolation invariant, D2).** **`UNIQUE(domain)` globally** — **no `tenant_id` in the
  key**. This is the database-level guarantee behind **D2**: the same sending domain can **never** be
  claimed by two tenants. (DNS-challenge ownership verification is `03`'s job; this constraint stops the
  double-claim regardless.)
- **Indexes.** `(tenant_id, status)`; the global `UNIQUE(domain)`.
- **Relationships.** `1—N mailbox_integration` (a mailbox sends **on** this domain).
- **RLS.** `ENABLE` + `FORCE`, **`tenant_id`-keyed** (`sending_domain_tenant_isolation`, §4.2) — a
  tenant-level asset visible to every workspace under the tenant.
- **Retention / DSAR.** Soft-status (`status='suspended'`) on removal; retained while any mailbox/send
  references it (don't orphan send-history). **Not a prospect-DSAR target** — it is tenant infrastructure,
  removed via tenant offboarding, not a Person erasure.

### 3.2 `mailbox_integration` — the connected sending identity (secrets live here, D7)

- **Purpose.** A connected sending identity — Google/Microsoft OAuth or SMTP/ESP — owned by a user in a
  workspace (`02`, **D1**). The **most sensitive** table in the subsystem: it holds **live credentials to a
  customer's real mailbox**. This is the **`EmailSenderPort` adapter's** backing row — M12 swaps the port
  to read these creds **without touching the M9 send tx** (`senderPort.ts`, **D11**).
- **Scope.** `tenant_id`, `workspace_id`, **`owner_user_id`** (the connecting user — FK `users`, **no
  cascade**, so a removed rep doesn't silently break send-history).
- **Key columns.** `id`, `tenant_id` (FK CASCADE), `workspace_id` (FK CASCADE), `owner_user_id`
  (FK `users`, no cascade), `provider` ∈ `{google,microsoft,smtp,ses,postmark}` (the **D1** hybrid set),
  `email_address` (varchar — display; the address itself is operational, not enrichable PII),
  `email_blind_index` (`bytea` HMAC — the dedup key, §4.4), `sending_domain_id` (FK → `sending_domain`,
  **SET NULL/RESTRICT**), `status` ∈ `{pending,connected,warming,error,disconnected}`,
  `oauth_creds_enc` (**`bytea` AES-GCM ciphertext** — access+refresh token blob, **D7**; **KMS-backed
  envelope encryption is the target**, app-AES-GCM today — the documented known gap),
  `smtp_creds_enc` (`bytea` ciphertext — SMTP/ESP secret), `warmup_state` ∈ `{none,warming,complete}`,
  `daily_send_limit` (integer — the per-mailbox throttle, **D10**), `connected_at` (nullable),
  `disconnected_at` (nullable), `created_at`, `updated_at`.
- **Secrets (D7, security precedence).** `*_enc` columns are **encrypted at rest**, **never returned to
  any client** (the repository projects them out of **every** DTO), **never logged**. On disconnect the
  repository **zeroes the secret columns** while keeping the row (send-history referential integrity).
- **Uniqueness.** **`UNIQUE(workspace_id, email_blind_index)` partial on live rows** — one connection per
  address per workspace (blind index because the address is treated like PII for dedup, §4.4).
- **Indexes.** `(workspace_id, status)`; `(tenant_id, sending_domain_id)`.
- **Relationships.** `N—1 sending_domain`; the sender the `outreach/sendStep` send tx sends **from** (via
  the port).
- **RLS.** `ENABLE` + `FORCE`, **`workspace_id`-keyed** (`mailbox_integration_workspace_isolation`).
  Owner-scoped visibility (**D8**) is an **app-layer** concern in `emailRepository` (`12`), layered on top
  of the harder workspace RLS boundary.
- **Retention / DSAR.** Soft-disconnect (`status`, `disconnected_at`, secrets zeroed); hard-delete per
  retention. A mailbox is the **sender**, not a data-subject of the tenant's prospects → **not a
  prospect-DSAR target**; removed via the owner's account deletion / tenant offboarding.

### 3.3 `email_event` — the high-volume PARTITIONED raw ESP/webhook event store

- **Purpose.** The **raw, append-only firehose** of every ESP/mailbox/webhook signal — the system of
  record for delivery/open/click/bounce/complaint/unsubscribe events at volume. It is **distinct from
  `activities`**: `activities` is the **curated, low-volume, per-contact timeline of record** (M8);
  `email_event` is the **high-volume raw ingest** that **feeds `activities`**. The ingestion worker
  (`email_tracking` queue, **D10**) dedups on `provider_event_id`, writes the raw row here, then derives a
  single `activities` row (carrying `metadata.eventId`/`messageId`/`deliveryStatus`, §2.4) — and a
  reply/bounce event drives the auto-pause (**D9**) and `handleBounce` (the existing M9 logic).
- **Scope.** `tenant_id`, `workspace_id`.
- **Key columns.** `id`, `tenant_id` (FK CASCADE), `workspace_id` (FK CASCADE), `contact_id`
  (FK `contacts.id` CASCADE, **nullable** — an event for an address with no local contact still records),
  `outreach_log_id` (FK `outreach_log.id` SET NULL, **nullable** — the enrollment/send this event concerns,
  **by id**), `message_id` (varchar — the ESP/mailbox message id; correlates the event to its send and to
  `activities.metadata.messageId`), `event_type` ∈
  `{delivery,open,click,bounce,complaint,unsubscribe}`, `provider` ∈ `{ses,postmark,google,microsoft,smtp}`,
  `provider_event_id` (varchar — the ESP/webhook event id; **the idempotency key**), `occurred_at`
  (timestamptz — the provider's event time; the **partition key**), `is_mpp_suspected` (bool — flags
  Apple-MPP-prefetched opens so **D6** de-emphasizes them, `04`), `metadata` (jsonb — **non-PII only**:
  clicked-URL hash, bounce class, user-agent class; **never** the message body or recipient PII),
  `created_at` (ingest time).
- **Partitioning (high-volume).** **Range-partitioned by day on `occurred_at`** (`PARTITION BY RANGE`) —
  a future-partition-creation + old-partition-drop job runs in `rls/email.sql`/a maintenance worker (the
  Postgres-native equivalent of the `outreach_log` / `source_imports` partition intent, scaled up because
  the raw event volume dwarfs them). New-partition creation is ahead-of-time; retention drop is by
  detaching/dropping past-window partitions (§ retention).
- **Uniqueness / dedup.** **`UNIQUE(provider_event_id)`** per the ESP namespace (carried into the partition
  key tuple as `(occurred_at, provider_event_id)` so the unique is partition-local) — the `email_tracking`
  ingestion queue is **at-least-once** (**D10**); a re-delivered webhook is a no-op via
  `ON CONFLICT DO NOTHING`. The per-tenant custom tracking host (`sending_domain.tracking_cname`, **D3**)
  means one tenant's tracking is never a shared blacklistable surface.
- **Indexes.** `(tenant_id, workspace_id, occurred_at DESC)` for the newest-first raw feed (a backwards
  index scan on the partition, not a seq-scan + sort); `(workspace_id, outreach_log_id, occurred_at)` for
  the per-send timeline; `(workspace_id, event_type, occurred_at DESC)` **partial on
  `event_type IN ('bounce','complaint','unsubscribe')`** for the compliance/auto-pause feed.
- **Relationships.** `N—1 contacts` (Person, by id, nullable); `N—1 outreach_log` (the enrollment, by id,
  nullable); **feeds** `activities` (derived, not FK'd — provenance carried in `activities.metadata.eventId`).
- **RLS.** `ENABLE` + `FORCE` on the **parent partitioned table** (policies propagate to partitions),
  **`workspace_id`-keyed** (`email_event_workspace_isolation`, §4.2).
- **Retention / DSAR.** **Default 90-day retention** (the raw firehose is short-lived; the durable record
  is the derived `activities` row + `last_delivery_status` cache) — enforced by **dropping past-window
  daily partitions**, not row-by-row deletes. **DSAR (§8):** the raw event holds no recipient address (it
  references the Person by id and carries a `message_id`, not an email), so DSAR reaches it via **CASCADE
  from the contact** (`contact_id ON DELETE CASCADE`); any event matched only by `message_id` to a redacted
  send ages out within the 90-day window. **No per-event PII nulling needed** — events carry none.

### 3.4 The per-tenant send-quota counter (the `creditRepository` lock pattern)

- **Purpose.** A **per-tenant outbound-send budget** — the count of sends a tenant may emit per window
  (day/month), enforced **fail-closed before any send leaves the building** (**D4**/**D10**). It is
  **distinct from `reveal_credit_balance`** (the reveal-credit money loop, `billing.ts`): a tenant can have
  reveal credits and still be over its send quota, and vice-versa. It is the rate/abuse + reputation
  backpressure control, not a billing balance.
- **Shape (reuse, don't reinvent).** It is **the exact `creditRepository` pattern** (`creditRepository.ts`):
  a counter column (proposed `send_quota_remaining` and `send_quota_window_start` on `tenants`, mirroring
  `reveal_credit_balance`), accessed through a new **`sendQuotaRepository`** with `lockBalance` =
  **`SELECT … FOR UPDATE`** on the `tenants` row (`creditRepository.ts:30`), `decrement` under the lock with
  a **DB `CHECK (send_quota_remaining >= 0)`** making over-send impossible (`creditRepository.ts:39`), and a
  window-reset analogous to `grantFromEvent`'s idempotent grant (`creditRepository.ts:89`). The send tx
  (`core/outreach/sendStep`) takes the quota lock **inside the same `withTenantTx`** as the suppression
  gate — one decrement per send, serialized per tenant, no double-spend.
- **Why a counter on `tenants`, not a new table.** The quota is a single per-tenant scalar with a reset
  window — the **same shape** as `reveal_credit_balance`, which is a column on `tenants` guarded by a CHECK
  and a `FOR UPDATE` lock. A separate table would fork the lock discipline the credit counter already
  proves; reuse it (**D11**).
- **RLS.** The `tenants` row is read under the tenant's GUC (`creditRepository.ts:34` already relies on the
  row being visible in the scoped tx); the `SELECT … FOR UPDATE` serializes concurrent sends for one tenant.
- **Retention / DSAR.** Not a data-subject record → not a DSAR target. The window-reset is an operational
  job (`13`).

---

## 4. Tenancy, RLS shape & encryption conventions (applies to every NEW table)

Identical across the three new tables; stated once so §3 does not repeat it. These are the TruePoint
constraints digest, made concrete, and they **match the reused tables byte-for-byte** (`rls/outreach.sql`,
`rls/billing.sql`, `rls/contacts.sql`).

### 4.1 The scope columns

- **`tenant_id` on every new table** — FK → `tenants.id` `ON DELETE CASCADE` (the cascade root). It is the
  RLS key for **`sending_domain`** (a tenant-level reputation asset, **D2**); for `mailbox_integration` and
  `email_event` it is defence-in-depth + the cascade root, **not** the sole RLS key (workspace is).
- **`workspace_id`** — FK → `workspaces.id` `ON DELETE CASCADE` — on `mailbox_integration` and `email_event`
  (the RLS boundary for those); **nullable** on `sending_domain` (tenant-wide or workspace-pinned).
- **`owner_user_id`** — FK → `users.id`, **no cascade** — on `mailbox_integration` (a removed rep must not
  silently break send-history). Per **D8**, owner-scoped visibility (owner + explicit shares +
  workspace-role; manager/admin override) is an **app-layer** concern (`12`), **not** an RLS one — RLS
  guarantees only the harder workspace/tenant property.

### 4.2 The RLS policy shape (ENABLE + FORCE, fail-closed `NULLIF`)

Every new table is `ENABLE` **and** `FORCE ROW LEVEL SECURITY`. **`FORCE`** removes the table-owner
exemption so the policy binds **everyone the app ever runs as** — migration/seed/admin paths connect as the
DB owner and would otherwise bypass RLS (the reasoning in `rls/outreach.sql`, `rls/contacts.sql`). Each
policy keys `USING` and `WITH CHECK` off the transaction-local GUC, with `NULLIF(..., '')` so an **unset or
`''`-reset** GUC reads as `NULL` and matches nothing — **fail-closed**:

```sql
-- packages/db/src/rls/email.sql (illustrative — the workspace-scoped shape, mirrors rls/lists.sql)
ALTER TABLE mailbox_integration ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailbox_integration FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mailbox_integration_workspace_isolation ON mailbox_integration;
CREATE POLICY mailbox_integration_workspace_isolation ON mailbox_integration
  USING      (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
```

`sending_domain` uses the **same shape keyed on `tenant_id`** / `app.current_tenant_id` (a tenant-level
asset shared across the tenant's workspaces). `email_event` is `workspace_id`-keyed on the **parent
partitioned table** so the policy propagates to every daily partition. `withTenantTx` (`client.ts`) opens
every scoped transaction by (a) `SET LOCAL ROLE leadwolf_app` — dropping to the **non-`BYPASSRLS`** app
role — and (b) setting `app.current_tenant_id` + `app.current_workspace_id` as **transaction-local** GUCs
(RDS-Proxy/PgBouncer-safe). Workers set tenant context **per job** (**D10**). The only sanctioned
cross-tenant path is the explicitly-audited `withPlatformTx`/`withPrivilegedTx` (DSAR §8; admin console
`11`) — never the tenant request flow.

> **Defence-in-depth (security precedence).** RLS is the hard boundary; `emailRepository` **also**
> app-filters by `workspace_id` and, for `mailbox_integration`, by ownership/share per **D8**. A
> client-supplied id that resolves to another workspace's row is **invisible under RLS** and the repository
> returns **not-found (→ 404)** — never an existence leak (IDOR → 404, the constraints digest).

### 4.3 Indexes — `tenant_id`-leading composite (the digest rule)

Every read index is **`tenant_id`-leading composite** (the same posture as
`idx_audit_log_tenant_occurred_at`, `billing.ts:215`):

- recency feeds (`email_event`) → `(tenant_id, workspace_id, occurred_at DESC)` so the newest-first slice is
  a backwards index scan on the partition, not a seq-scan + sort on an ever-growing append-only firehose.
- lookup-by-parent (`email_event` by send) → `(workspace_id, outreach_log_id, occurred_at)`.
- mailbox/domain status reads → `(workspace_id, status)` / `(tenant_id, status)`.

### 4.4 Secrets at rest (D7) — `bytea` ciphertext + blind index

Mailbox credentials are **live credentials to a customer's real mailbox** (`00 §1`, **D7**) — the
highest-sensitivity columns in the subsystem. They follow the **exact** idiom `contacts.ts` /
`billing.ts` already use:

- Secret columns (`mailbox_integration.oauth_creds_enc`, `smtp_creds_enc`) are **`bytea` ciphertext** —
  `customType<{ data: Uint8Array }>` (`billing.ts:24`). Encrypted **at the app layer with AES-GCM today;
  KMS-backed envelope encryption is the target** (the documented **known gap** — KMS not yet wired). They
  are **never sent to the client and never logged** (**D7**; audit stores ids + actions, never secrets).
- Where the mailbox address must be **de-duplicated**, a **blind index** column holds `HMAC(normalized
  value)` as `bytea` — unique constraints can't run on ciphertext (the `contacts.ts:107` note). So
  `mailbox_integration.email_blind_index` powers `UNIQUE(workspace_id, email_blind_index)`. The
  suppression/DSAR fan-out matches on the **existing** `contacts.email_blind_index` /
  `suppression_list.email_blind_index` — no new blind-index plumbing.

---

## 5. Closed enums (mirrored in `@leadwolf/types`)

Each NEW closed enum is a `check()` in `email.ts` whose values **mirror** `packages/types/src/email.ts`
(the source of truth, the `outreach.ts:4` idiom). The reused tables keep their **existing** enums in
`types/src/{outreach,billing,activity,compliance}.ts` — **do not redefine them here.** New vocabulary only:

- `sending_domain.status` ∈ `{ pending, verifying, verified, failed, suspended }`;
  `sending_domain.dmarc_policy` ∈ `{ none, quarantine, reject }`;
  `sending_domain.reputation_state` ∈ `{ unknown, healthy, at_risk, blocked }`;
  `sending_domain.warmup_state` ∈ `{ none, warming, complete }`.
- `mailbox_integration.provider` ∈ `{ google, microsoft, smtp, ses, postmark }` (the **D1** hybrid set);
  `mailbox_integration.status` ∈ `{ pending, connected, warming, error, disconnected }`;
  `mailbox_integration.warmup_state` ∈ `{ none, warming, complete }`.
- `email_event.event_type` ∈ `{ delivery, open, click, bounce, complaint, unsubscribe }`
  (**opens carried but de-emphasized — D6**; `is_mpp_suspected` flags Apple-MPP-prefetched opens, `04`);
  `email_event.provider` ∈ `{ ses, postmark, google, microsoft, smtp }`.

> **No new enum on the reused tables.** `outreach_log.status`, `suppression_list.scope`/`match_type`/`reason`,
> `consent_records.lawful_basis`, `activities.activity_type`/`channel`, and the `audit_log` action enum are
> **already** sufficient (§2). The two additive `outreach_steps` columns (`template_version_id`,
> `variant_weight`) carry no closed enum.

---

## 6. Entity-relationship overview

### 6.1 The relationship list (references, not copies)

- `tenants 1—N { all email rows }` (FK `tenant_id`, **CASCADE** — the deletion root).
- `workspaces 1—N { mailbox_integration, email_event, (optionally sending_domain) }` (FK `workspace_id`,
  **CASCADE**) — **the RLS boundary** for those tables.
- `sending_domain 1—N mailbox_integration` (FK `sending_domain_id`, **SET NULL/RESTRICT**) — a mailbox
  sends **on** a tenant-authenticated domain (**D2**); `sending_domain` is **tenant**-scoped.
- `mailbox_integration` is the sender the **existing** `outreach/sendStep` send tx sends **from** (via the
  `EmailSenderPort` seam — **D11**); it is **not** copied into any send row.
- `email_event N—1 contacts` (FK `contact_id`, **CASCADE**, nullable — the Person), `N—1 outreach_log`
  (FK `outreach_log_id`, **SET NULL**, nullable — the enrollment/send), and **feeds** `activities`
  (derived, provenance via `activities.metadata.eventId` — not an FK).
- `outreach_steps N—1 <template_version>` (the new `template_version_id`, **SET NULL** — a step references
  a template **by id**, never copies it; `01`).
- The reused relationships are unchanged: `outreach_sequences 1—N outreach_steps` (CASCADE);
  `outreach_sequences 1—N outreach_log` (CASCADE); `outreach_log N—1 contacts` (CASCADE);
  `suppression_list`/`consent_records` `N—1 contacts` (CASCADE).

> **The FK is not a workspace guard.** A foreign key proves the referenced row **exists**, not that it is in
> the **same workspace** — FK existence checks run with the table owner's privilege and bypass RLS (the
> note on `list_members.contact_id`, `lists.ts`). So every write path that accepts a client-supplied id
> (`contact_id`, `outreach_log_id`, `sending_domain_id`, `mailbox_integration_id`) **must re-validate that
> id under the caller's `withTenantTx`** in `emailRepository` (the `visibleContactIds` pattern,
> `listRepository.ts:126`) and drop a foreign id — never rely on the FK for isolation.

### 6.2 ASCII sketch

```
                    ┌──────────┐
                    │ tenants  │  (tenant_id; CASCADE root; RLS key for sending_domain;
                    └────┬─────┘   carries reveal_credit_balance + the NEW send_quota counter, §3.4)
                         │ 1:N
                    ┌────▼──────┐
                    │workspaces │  ◄── the RLS boundary (app.current_workspace_id)
                    └────┬──────┘
   ┌─────────────────────┼───────────────────────────┬──────────────────────────┐
   │ EXISTING (reused, D11)                           │ NEW (M12)                 │
   │                     │                            │                           │
┌──▼───────────────┐ ┌───▼──────────┐  ┌──────────────▼───────┐  ┌───────────────▼────────┐
│ outreach_        │ │ outreach_log │  │ mailbox_integration  │  │   sending_domain        │
│  sequences       │ │ (ENROLLMENT; │  │ (O; secrets _enc, D7;│  │ (tenant_id; SPF/DKIM/   │
│ (CAN-SPAM ids)   │ │  +last_      │  │  EmailSenderPort)    │  │  DMARC; tracking_cname; │
└──┬───────────────┘ │  delivery_   │  └───────────┬──────────┘  │  UNIQUE(domain) global) │
   │1:N              │  status, §2.3│              │ N:1          └─────────────────────────┘
┌──▼───────────────┐ │  +next_run_at│   ┌──────────▼─────────┐
│ outreach_steps   │ └───┬──────────┘   │  (sends FROM here   │
│ (+template_      │     │ N:1 contacts │   via the M9 send tx)│
│  version_id,     │     │ (Person)     └─────────────────────┘
│  +variant_weight)│     │
└──────────────────┘     ▼
   suppression_list ──► assertNotSuppressed (the D4 gate; runs IN-TX in sendStep)
   consent_records  ──► same fail-closed send gate (D9)
   idempotency_keys ──► the D5 stored-response replay (UNIQUE(tenant_id, key))
                                             │
                          ┌──────────────────▼───────────────────┐
                          │ email_event  (NEW; PARTITIONED by day │  open/click/reply(bounce)/
                          │  on occurred_at; UNIQUE(provider_     │  unsub/complaint/delivery
                          │  event_id); 90d retention via partn   │  N:1 contacts (Person, nullable)
                          │  drop)  ──FEEDS──►  activities         │  N:1 outreach_log (nullable)
                          └───────────────────┬───────────────────┘
                                              │ derives (metadata.eventId/messageId/deliveryStatus)
                                  ┌───────────▼───────────┐
                                  │ activities (M8 — the  │  email_sent/opened/clicked/replied
                                  │  timeline of record)  │
                                  └───────────────────────┘
        contacts (the canonical Person — contacts.ts; email_enc / email_blind_index /
        deleted_at tombstone) is the DSAR anchor (§8). NO new person table.
```

- The **canonical Person is the existing `contacts` row** — the email subsystem **adds no new person
  table**; it references `contacts.id` and reuses `contacts.email_blind_index` / `contacts.deleted_at` for
  the suppression gate and DSAR cascade.
- The **enrollment is `outreach_log`**, the **send tx is `core/outreach/sendStep`**, the **gate is
  `assertNotSuppressed` over `suppression_list` + `consent_records`** — all reused, not rebuilt (**D11**).

---

## 7. The mandatory cross-tenant isolation itest (Phase 0 gate)

The reused tables already have their isolation itests (`outreach.itest.ts`, `suppression`/`consent`/`audit`
coverage). This is the **non-negotiable P0 gate** (`00 §8`, `13`) for the **new** tables: a real-Postgres
integration test proving **tenant A can neither see nor modify tenant B's `sending_domain` /
`mailbox_integration` / `email_event` rows**. Add `packages/db/src/test/email.itest.ts`, modelled directly
on `savedSearches.itest.ts` / the List tab's `lists.itest.ts`. It runs against a real Postgres
(Testcontainers by default, or `ITEST_DATABASE_URL`) in its own process.

**Setup (mirrors the saved-search/list itest).** `applyMigrations(adminUrl)`, then seed via the
**BYPASSRLS admin connection**: two tenants × one workspace each — `tenantA/wsA/ownerA` and
`tenantB/wsB/ownerB` — plus a second member `coworkerA` of `wsA`. Seed each with a `sending_domain`, a
`mailbox_integration` (with encrypted secret bytes), and a handful of `email_event` rows tied to a seeded
`outreach_log` + `contacts` row.

**Assertions** (each cross-tenant assertion runs through `withTenantTx` as `leadwolf_app` under B's GUCs;
"A is untouched" checks use the BYPASSRLS admin connection):

1. **Read isolation.** In scope B, every `emailRepository` list/find for sending domains, mailboxes, and
   events returns **none** of A's rows.
2. **Write isolation.** In scope B, attempts to insert a `mailbox_integration` referencing A's
   `sending_domain_id`, or an `email_event` referencing A's `contact_id` / `outreach_log_id`, all
   **no-op / 404** (RLS hides the row; the FK-not-a-guard re-validation drops the foreign id — §6.1).
   Verify via admin that A's rows are unchanged.
3. **Mutation isolation.** B's `update*` / `delete*` against A's ids no-op/404 — **no existence leak**.
4. **Sending-domain uniqueness (D2).** Seeding the **same domain** for tenant B violates the **global
   `UNIQUE(domain)`** — proven at the DB level (no sending domain shared across tenants).
5. **Tenant-scoped domain visibility.** A `sending_domain` with `workspace_id = NULL` is visible to **every**
   workspace under its tenant (the `tenant_id`-keyed policy, §4.2) but **invisible** to the other tenant.
6. **Secret confidentiality (D7).** Every `mailbox_integration` DTO the repository returns has the `*_enc`
   columns **projected out** (no ciphertext, no plaintext) — asserted on the read path.
7. **Partition + dedup (email_event).** A re-inserted `provider_event_id` is a **no-op**
   (`ON CONFLICT DO NOTHING`); a row whose `occurred_at` falls in a different day lands in the correct daily
   partition; the parent-table RLS policy applies to the partition (B reads zero of A's events).
8. **Owner-gating within a workspace (the app-layer half, D8).** `coworkerA` cannot edit/disconnect
   `ownerA`'s mailbox (owner-gated → not-found) but **can** see workspace-shared metadata — mirrors the List
   tab's owner-gating case.
9. **Unscoped = nothing (fail-closed).** A `withTenantTx` with no `workspaceId` reads **zero** rows from the
   workspace-scoped new tables (the `NULLIF(...,'')` GUC semantics).

> **Known gap to add (flag in the doc, per the constraints digest).** This db-level itest proves **RLS
> isolation at the data layer**. There is **NO per-endpoint cross-tenant HTTP isolation test** today — a
> test that drives the actual `apps/api/src/features/email/routes.ts` endpoints with tenant A's auth against
> tenant B's ids and asserts a 404. That HTTP-layer isolation test is a **named gap to add** (the same gap
> the constraints digest flags generally) — the db itest is necessary but not sufficient; the endpoint test
> catches a route that forgets to open `withTenantTx` or trusts a client id. Track it in `13` as a P0/P1
> hardening item. (The reused outreach routes already carry this coverage; the **new** `/email` routes
> must add it.)

**DoD (per `13`/`00 §8`):** migrations apply; RLS proven `ENABLE`+`FORCE` on `sending_domain` /
`mailbox_integration` / `email_event` (and propagated to `email_event` partitions); the isolation itest is
green; **0 cross-tenant leaks**.

---

## 8. DSAR / deletion cascade (D9)

Per `06-compliance.md`, **ADR-0021** (`docs/planning/decisions/ADR-0021-global-master-graph-and-overlay.md`),
and the **existing, shipped** DSAR pattern (`compliance.ts`, `list-plan/08`), a data subject spans **every**
tenant, so erasure is the audited **platform fan-out** — run under `withPrivilegedTx`/`withPlatformTx`
(never the tenant flow), keyed off the **`dsar_requests.subject_email_blind_index`** (the find-everywhere
key, `compliance.ts:52`). The cascade reaches the email subsystem because the reused rows reference the
canonical **Person** (`contacts.id`) and carry blind-index columns the fan-out already matches. For each
matched Person, in every workspace:

1. **Tombstone the Person.** The **existing** step — set `contacts.deleted_at` and null the PII
   (`email_enc`, `email_blind_index`, name) — the documented `contacts` tombstone (`contacts.ts:147`). This
   is the anchor; the email rows follow.
2. **Dis-enroll (existing tables).** Resolve all **`outreach_log`** rows for the Person to a terminal state
   (`status='unsubscribed'`, the new `next_run_at = NULL`, §2.3) so **no further send can be scheduled**
   (**D9**). This is the reused enrollment table — no new dis-enroll path.
3. **Drop raw events.** **`email_event`** rows for the Person cascade via `contact_id ON DELETE CASCADE`;
   any event matched only by `message_id` ages out within the **90-day** partition-drop window. Events carry
   **no recipient PII**, so there is no per-event nulling.
4. **Withdraw consent (existing table).** Set **`consent_records`** `withdrawn_at` (and the app-level
   opt-out) for the Person (§2.6).
5. **Suppress to block re-contact + re-import (existing table).** Insert a **`suppression_list`** row with
   `reason='dsar'`, matched by `email_blind_index`, and — for cross-tenant erasure — a **`global`-scope**
   row (§2.5). Because **`assertNotSuppressed`** runs **in-tx on every send** and global rows are visible to
   every scope, a re-uploaded/re-enriched copy of the erased Person is **gated before any mail can leave** —
   the durable "do not re-create / do not re-contact" memory (the exact `list-plan/08 §5.2` mechanism).
6. **Audit.** The erasure writes **`dsar.delete`** to the customer-visible `audit_log` (the verb exists,
   `billing.ts:192`) and the platform fan-out writes its `platform_audit_log` row in the same tx — **ids +
   actions only, never PII or message bodies** (`00 §5`).

**How the cascade *finds* every email reference (the digest's "find ALL tenant references" rule).** The
fan-out does not enumerate sequences; it resolves by the **blind index**: `contacts.email_blind_index` →
all `outreach_log.contact_id` / `email_event.contact_id` / `consent_records.contact_id` for that Person in
every workspace, **plus** any `suppression_list` matched directly by `email_blind_index` (covering an
address with no local contact row). One identity → fan out to every email overlay — the same "deletion
provable via the golden identity" property ADR-0021 gives Lists. `mailbox_integration` and `sending_domain`
are **not** prospect-DSAR targets (tenant infrastructure, §3.1/§3.2).

**The DSAR-cascade itest (P6, owned by `13`; complements §7).** Seed the same Person enrolled (`outreach_log`)
+ with `email_event` rows in two workspaces, run the platform erasure, and assert: enrollments terminal +
`next_run_at` null, events cascaded/aged, consent withdrawn, a `dsar` (and `global`) `suppression_list` row
present, and a re-enroll/re-send of the erased Person is **blocked by `assertNotSuppressed`**.

---

## 9. Summary of changes (the `db` / `types` work)

| File | Change |
|---|---|
| `packages/db/src/schema/email.ts` | **New.** Only the three genuinely-new tables — `sending_domain` (global `UNIQUE(domain)`, **D2**), `mailbox_integration` (`bytea` secrets, **D7**), `email_event` (PARTITIONED by day, `UNIQUE(provider_event_id)`) — with the local column-factory idioms, `bytea`/`citext` `customType` helpers, closed-enum `check()`s mirroring `types/src/email.ts`, and `tenant_id`-leading composite indexes. **No** sequence/step/enrollment/suppression/consent/idempotency tables (reused per **D11**). |
| `packages/db/src/schema/outreach.ts` | **Edited (additive).** `outreach_steps` += `template_version_id` (FK, SET NULL) + `variant_weight` (int, `>=0`); `outreach_log` += `last_delivery_status` (cache) + `next_run_at` (scheduler cursor). All nullable/defaulted → non-destructive. |
| `packages/db/src/schema/activity.ts` | **No column change.** Email facts ride in the existing `activities.metadata` jsonb (`messageId`/`deliveryStatus`/`eventId`/`isMppSuspected`, §2.4); the email-event activity types already exist. |
| `packages/db/src/schema/auth.ts` (`tenants`) | **Edited (additive).** `send_quota_remaining` + `send_quota_window_start` columns + `CHECK (send_quota_remaining >= 0)` — the per-tenant send-quota counter, the `creditRepository` shape (§3.4); distinct from `reveal_credit_balance`. |
| `packages/db/src/schema/billing.ts` (`audit_log`, `suppression_list`, `idempotency_keys`) | **No change.** Reused verbatim — the `audit_log` verbs, the suppression scope/match model + in-tx gate, and the `UNIQUE(tenant_id, key)` idempotency store are all already sufficient (§2.5/§2.7/§2.8). |
| `packages/db/src/rls/email.sql` | **New.** `ENABLE`+`FORCE` + one isolation policy per new table (workspace-keyed for `mailbox_integration`/`email_event`; tenant-keyed for `sending_domain`), the `email_event` partition policy + maintenance, `set_updated_at()` triggers, closing `GRANT … TO leadwolf_app`. Idempotent. The reused tables' RLS (`rls/outreach.sql`, `rls/billing.sql`, `rls/compliance.sql`) is **unchanged**. |
| `packages/db/src/repositories/emailRepository.ts` | **New.** The sole data-access layer for the new tables — tx-aware methods; FK-not-a-guard re-validation of every client id (the `visibleContactIds` pattern); secret columns projected out of every DTO (**D7**). |
| `packages/db/src/repositories/sendQuotaRepository.ts` | **New.** The send-quota counter — the `creditRepository` `SELECT … FOR UPDATE` + CHECK pattern (§3.4), composed inside the `outreach/sendStep` tx. |
| `packages/types/src/email.ts` | **New.** Zod source of truth — the new closed enums (§5) + the DTOs/cursor-paginated reads; the schema `check()`s mirror this file. Reused tables keep their existing types. |
| `packages/core/src/email/` | **New.** Framework-free domain verification / mailbox connect / event-ingestion → `activities` fan-out / quota logic over the new repositories — composing the **existing** `core/outreach/sendStep` + `assertNotSuppressed`, not re-implementing them. |
| `packages/db/src/test/email.itest.ts` | **New.** The two-tenant cross-tenant isolation itest for the new tables (§7); the DSAR-cascade itest lands in P6 (§8). |
| `packages/db/migrations/00NN_*.sql` | **Generated** by `bun run db:generate` (then `db:migrate`) — do not hand-edit; the meta snapshot stays in lockstep (the `list-plan/02 §2.3` migration discipline). |

> **Known gaps carried forward** (the constraints digest, restated so they are not lost): KMS not yet wired
> — mailbox secrets use **app-AES-GCM + blind index today** (**D7** target); **no per-endpoint cross-tenant
> HTTP isolation test** for the new `/email` routes — add it (§7); the send-quota counter is **unwired** and
> the **leader-locked scheduler** for the `outreach_log.next_run_at` tick (§2.3) must be confirmed — tracked
> in `13`; `email_event` daily-partition creation/drop is an **operational job** to stand up (§3.3);
> multi-region residency siloing absent (`00 §2` out of scope).

---

**Sources (schema-pattern claims):**

- [HubSpot: Understand email sending in HubSpot](https://knowledge.hubspot.com/marketing-email/understand-email-sending-in-hubspot) — validates the mailbox-vs-relay split (**D1**) and per-tenant authenticated sending domains the `mailbox_integration` / `sending_domain` split encodes.
- [Google: Email sender guidelines](https://support.google.com/a/answer/81126) — the SPF/DKIM/DMARC + one-click-unsubscribe + < 0.30% complaint floor behind `sending_domain`, the reused `suppression_list`, and `consent_records`.
- [Mailchimp: Apple Mail Privacy Protection (MPP) FAQs](https://mailchimp.com/help/apple-privacy-faq/) — the open-inflation reality behind `email_event.is_mpp_suspected` and **D6** (reply rate, not opens).
