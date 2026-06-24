# Email Subsystem — Data Model, RLS, Isolation Guarantee & DSAR Cascade (09)

> **Status:** Plan (not yet built). **Owner:** Data + Platform. **Last updated:** 2026-06-24.
> This is the **canonical schema** document for the `docs/planning/email-planning/` set. It **OWNS the
> twelve email entities** named in `00-overview.md §4` — every other doc references these entities **by
> name and by column**, and none may redefine them. It cites the **Locked Decisions (D1–D10)**, the
> **Shared Vocabulary**, and the **Phase Map (P0–P6)** from `00-overview.md`, and lands its content in
> **Phase 0** per `13-rollout-phases.md`.
>
> **Scope:** this is the `packages/db` + `@leadwolf/types` slice — schema, RLS, the sole repository, the
> isolation itest, and the DSAR cascade. The send path is `02`; templating is `01`; tracking is `04`;
> sequences are `05`; compliance is `06`; the isolation guarantee in depth is `07`; the surfaces are `10`
> / `11`. Where this doc names a column or constraint that a sibling relies on, **the sibling defers to
> this doc**.
>
> **Convention (matches `list-plan/02-data-model.md`):** plain English + schema/table/column names; no
> migrations or TypeScript; a single tiny illustrative RLS snippet is included because the List-tab data
> model does the same. This is a **design** doc grounded in the **TruePoint constraints digest** and the
> sibling docs' needs — external citations appear only where an industry/schema-pattern claim is made.

---

## 1. Where this lands in the codebase (the file contract)

The email subsystem is **new** — there is no email schema, RLS file, or repository today (`00 §5`). It is
**not** greenfield infrastructure: it reuses the same tenancy, encryption, audit, and DSAR machinery the
List tab and the contacts/compliance schemas already use (`packages/db/src/schema/contacts.ts`,
`compliance.ts`, `billing.ts`). The new files, exactly as named in `00 §5`:

| File | Role |
|---|---|
| `packages/db/src/schema/email.ts` | Drizzle schema for **all twelve** email entities (one cohesive schema unit, like `contacts.ts`). Reuses the local column-factory idioms (`id()`, `tenantId()`, `workspaceId()`, `createdAt()`, `updatedAt()`) and the `bytea` / `citext` `customType` helpers. |
| `packages/db/src/rls/email.sql` | Idempotent RLS file: `ENABLE` + `FORCE ROW LEVEL SECURITY` per table, one `*_workspace_isolation` (or `*_tenant_isolation`) policy each, the shared `set_updated_at()` triggers, and the closing `GRANT` to `leadwolf_app`. Applied by `applyMigrations` in the sorted `rls/*.sql` pass. |
| `packages/db/src/repositories/emailRepository.ts` | **The sole data-access layer** for email rows. Every method is `tx`-aware (composed inside one `withTenantTx` by `packages/core/src/email/`), so RLS scopes every read and write. No email SQL is ever issued outside this repository. |
| `packages/db/src/test/email.itest.ts` | The mandatory **two-tenant cross-tenant isolation itest** (§7), modelled on `savedSearches.itest.ts` / the List tab's `lists.itest.ts`. |
| `packages/core/src/email/` | Framework-free domain logic (render, scheduling, suppression/consent gate composition) — calls the repository, never the DB directly. |
| `packages/types/src/email.ts` | The Zod source of truth for every closed enum and DTO; the `check()` enums in `email.ts` **mirror** this file (the same idiom `outreach.ts` documents). |

**References, not copies (the data rule).** Every email row that "is about" a Person, a Template, a
Mailbox, or a Sequence stores **only the foreign-key id** of the canonical row — never a snapshot of its
fields. An `email_send` references the canonical **Person** (`contacts.id`) and the
`email_template` / `email_template_version` it rendered **by id**; it does not copy the Person's email
address, name, or the template body into the send row. (The one disciplined exception is an
**append-only, immutable point-in-time artifact** the system is legally or operationally required to
preserve — the rendered subject/body actually transmitted, and the resolved recipient address at send
time. These are recorded on `email_send` deliberately, not as denormalization, and §6.6 explains why.)

---

## 2. Entity catalog (the one-screen contract)

The twelve canonical entities (`00 §4`). **Scope columns**: `T` = `tenant_id` (always present);
`W` = `workspace_id` (workspace-scoped rows); `O` = `owner_user_id` (user-owned rows). All scoped rows
also carry `created_at` / `updated_at` where mutable. RLS is **`ENABLE` + `FORCE`** on every table; the
key column is named in the RLS column.

| Entity | Scope (T/W/O) | Key domain columns | RLS key | Uniqueness / dedup | Retention |
|---|---|---|---|---|---|
| `email_template` | T, W, O | `name`, `category`, `status`, `current_version_id`, `shared_scope` | `workspace_id` | `UNIQUE(workspace_id, name)` partial on `deleted_at IS NULL` | soft-delete (`deleted_at`) + archive; hard-delete sweep per tenant retention |
| `email_template_version` | T, W | `template_id`, `version_no`, `subject`, `body_html`, `body_text`, `variables`, `is_published` | `workspace_id` | `UNIQUE(template_id, version_no)` | follows parent template; published versions retained while any `email_send` references them |
| `email_sequence` | T, W, O | `name`, `status`, `from_mailbox_strategy`, `physical_address`, `auto_pause_on_reply` | `workspace_id` | `UNIQUE(workspace_id, name)` partial on `deleted_at IS NULL` | soft-delete + archive; hard-delete sweep per retention |
| `email_sequence_step` | T, W | `sequence_id`, `step_order`, `channel`, `delay_hours`, `template_id`, `branch_condition` | `workspace_id` | `UNIQUE(sequence_id, step_order)` | cascades with parent sequence |
| `email_enrollment` | T, W, O | `sequence_id`, `contact_id`, `status`, `current_step`, `next_run_at`, `paused_reason` | `workspace_id` | `UNIQUE(sequence_id, contact_id)` (enrollment idempotency) | soft-complete (`status`, `completed_at`); high-volume, range-partition target |
| `email_send` | T, W, O | `contact_id`, `mailbox_integration_id`, `template_version_id`, `enrollment_id`, `sequence_step_id`, `status`, `provider_message_id`, `subject_snapshot`, `recipient_email_enc`, `recipient_email_blind_index` | `workspace_id` | `UNIQUE(workspace_id, idempotency_key)` (via `email_idempotency_key`, **D5**) | high-volume, range-partition target; per-tenant retention then hard-delete; recipient PII nulled on DSAR |
| `email_tracking_event` | T, W | `email_send_id`, `event_type`, `occurred_at`, `provider_event_id`, `is_mpp_suspected`, `metadata` | `workspace_id` | `UNIQUE(email_send_id, provider_event_id)` (webhook idempotency) | append-only; high-volume, range-partition target; per-tenant retention |
| `mailbox_integration` | T, W, O | `provider`, `email_address`, `status`, `oauth_tokens_enc`, `smtp_secret_enc`, `email_blind_index`, `warmup_state`, `daily_send_limit` | `workspace_id` | `UNIQUE(workspace_id, email_blind_index)` partial on live rows | soft-disconnect (`status`, `disconnected_at`); **secrets zeroed on disconnect**; hard-delete per retention |
| `sending_domain` | T, (W optional) | `domain`, `status`, `spf_verified`, `dkim_selector`, `dkim_verified`, `dmarc_policy`, `tracking_cname`, `dedicated_ip` | `tenant_id` | `UNIQUE(domain)` global (no domain shared across tenants — **D2**) | soft-delete; retained while any mailbox/send references it |
| `email_suppression` | T, W | `scope`, `match_type`, `normalized_email`, `email_blind_index`, `domain`, `contact_id`, `reason` | `workspace_id` (+ tenant/global rows) | `UNIQUE(tenant_id, workspace_id, normalized_email)` per **D4** (+ tenant/global variants) | **never auto-purged** (legal memory); DSAR adds rows, does not remove them |
| `email_consent` | T, W | `contact_id`, `jurisdiction`, `lawful_basis`, `opt_state`, `source`, `valid_from`, `valid_until`, `withdrawn_at` | `workspace_id` | `UNIQUE(workspace_id, contact_id, jurisdiction)` (latest basis) | retained per compliance window; withdrawal is a state change, not a delete |
| `email_idempotency_key` | T, W | `idempotency_key`, `response_status`, `response_body`, `email_send_id` | `workspace_id` | `UNIQUE(workspace_id, idempotency_key)` (**D5**) | short TTL (replay window) then sweep |

> **Why `email_idempotency_key` is workspace-scoped, not tenant-scoped.** The existing
> `idempotency_keys` table (`billing.ts:152`) keys `UNIQUE(tenant_id, key)`. The email send path is
> **workspace-scoped** end-to-end (mailbox, sequence, suppression are all workspace rows), so the email
> idempotency key is `UNIQUE(workspace_id, idempotency_key)` per **D5** — a key replayed in a different
> workspace is a genuinely different send. The shared `idempotency_keys` table stays for the money
> endpoints; email gets its own table because the send path needs to link the stored response **to the
> `email_send` row it created** (`email_send_id`) so a retried `POST` returns the original send, not a
> second one.

---

## 3. Tenancy, RLS shape & encryption conventions (read once, applies to every entity)

These four conventions are **identical across all twelve entities** and are stated here so §6 does not
repeat them. They are the constraints digest, made concrete.

### 3.1 The scope columns

- **`tenant_id` is on every table** — FK → `tenants.id` `ON DELETE CASCADE`. It is never the RLS key on
  its own for workspace-scoped rows (defence-in-depth + the cascade root), but it **is** the RLS key for
  `sending_domain` (a tenant-level reputation asset, **D2**).
- **`workspace_id`** — FK → `workspaces.id` `ON DELETE CASCADE` — on every **workspace-scoped** row
  (everything except the optionally-tenant-level `sending_domain`). This **is the RLS boundary** for those
  tables.
- **`owner_user_id`** — FK → `users.id`, **no cascade** (a removed rep must not silently delete a shared
  template/sequence/send — same reasoning as `lists.owner_user_id`). Present on the **user-owned** entities
  (`email_template`, `email_sequence`, `email_enrollment`, `email_send`, `mailbox_integration`). Per **D8**,
  owner-scoped visibility (owner + explicit shares + workspace-role; manager/admin override) is an
  **app-layer** concern (`12`), **not** an RLS concern — RLS guarantees only the harder workspace property.

### 3.2 The RLS policy shape (ENABLE + FORCE, fail-closed `NULLIF`)

Every email table is `ENABLE` **and** `FORCE ROW LEVEL SECURITY`. **`FORCE`** removes the table-owner
exemption so the policy binds **everyone the app ever runs as** — migration/seed/admin paths connect as
the DB owner and would otherwise silently bypass RLS (exactly the reasoning in `lists.sql:12`,
`contacts.sql:18`). Each policy keys `USING` and `WITH CHECK` off the transaction-local GUC, with
`NULLIF(..., '')` so an **unset or `''`-reset** GUC reads as `NULL` and matches nothing — **fail-closed**:

```sql
-- packages/db/src/rls/email.sql (illustrative — the workspace-scoped shape)
ALTER TABLE email_send ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_send FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS email_send_workspace_isolation ON email_send;
CREATE POLICY email_send_workspace_isolation ON email_send
  USING      (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
```

`sending_domain` uses the same shape keyed on **`tenant_id`** / `app.current_tenant_id` (it is a
tenant-level asset shared across that tenant's workspaces). `email_suppression` keys on `workspace_id`
**plus** the read-side exposure of `tenant`- and `global`-scope rows to every workspace in scope — see
§6.10. `withTenantTx` (`client.ts`) opens every scoped transaction by (a) `SET LOCAL ROLE leadwolf_app`
— dropping to the **non-`BYPASSRLS`** app role — and (b) setting `app.current_tenant_id` +
`app.current_workspace_id` as **transaction-local** GUCs (RDS-Proxy/PgBouncer-safe). The one sanctioned
cross-tenant path is the explicitly-audited `withPlatformTx` / `withPrivilegedTx` (DSAR, §8; admin
console, `11`) — never the tenant request flow.

> **Defence-in-depth (security precedence).** RLS is the hard boundary; the repository **also**
> app-filters by `workspace_id` and, for `email_send`/`email_template`, by ownership/share per **D8**. A
> client-supplied id that resolves to another workspace's row is **invisible under RLS** and the
> repository returns **not-found (→ 404)**, never an existence leak (IDOR → 404, the constraints digest).

### 3.3 Indexes — `tenant_id`-leading composite (the digest rule)

Every read index is **`tenant_id`-leading composite** (the constraints digest; the same posture as
`idx_audit_log_tenant_occurred_at`). The hot reads each entity needs are named in §6; in summary:

- recency feeds (sends, tracking events) → `(tenant_id, workspace_id, created_at DESC)` or
  `(workspace_id, occurred_at DESC)` so the newest-first slice is a backwards index scan, not a
  seq-scan + sort on an append-only, ever-growing table.
- lookup-by-parent (steps by sequence, versions by template, events by send) → `(workspace_id, <parent_id>)`.
- suppression/blind-index gate → `(workspace_id, email_blind_index)` and the tenant/global variants, so
  the **in-tx suppression check on every send** (§6.10, **D4**) is an index hit.

### 3.4 Secrets at rest (D7) — `bytea` ciphertext + blind index

Mailbox credentials are **live credentials to a customer's real mailbox** (`00 §1`, **D7**) — the
highest-sensitivity columns in the subsystem. They follow the **exact** idiom `contacts.ts` /
`compliance.ts` already use for PII:

- Secret columns (`mailbox_integration.oauth_tokens_enc`, `smtp_secret_enc`; `email_send`'s
  `recipient_email_enc`) are **`bytea` ciphertext** — `customType<{ data: Uint8Array }>`. Encrypted **at
  the app layer with AES-GCM today; KMS-backed envelope encryption is the target** (the documented **known
  gap** in the constraints digest — KMS not yet wired). They are **never sent to the client and never
  logged** (**D7**; audit stores ids + actions, never secrets or bodies).
- Where a secret/PII column must be **looked up or de-duplicated**, a **blind index** column holds
  `HMAC(normalized value)` as `bytea` — unique constraints and equality lookups can't run on ciphertext
  (the note `contacts.ts:4` makes). So `mailbox_integration.email_blind_index` powers
  `UNIQUE(workspace_id, email_blind_index)` and `email_suppression.email_blind_index` /
  `email_send.recipient_email_blind_index` power the suppression gate and DSAR fan-out.
- `email_suppression.normalized_email` is stored **in clear** (lower-cased, trimmed) — the canon names
  it as the uniqueness key (`UNIQUE(tenant_id, workspace_id, normalized_email)`, **D4**). A suppression
  address is by definition a do-not-contact value, not enrichable PII; storing it clear keeps the
  legally-required "is this address suppressed?" check a plain equality. (The blind index is **also**
  carried so the DSAR/global fan-out can match by the same key the master graph uses.)

---

## 4. Entity-relationship overview

### 4.1 The relationship list (references, not copies)

- `tenants 1—N { all email entities }` (FK `tenant_id`, **CASCADE** — the deletion root).
- `workspaces 1—N { all workspace-scoped email entities }` (FK `workspace_id`, **CASCADE**) — **the RLS
  boundary**.
- `email_template 1—N email_template_version` (FK `template_id`, **CASCADE**); `email_template.current_version_id`
  is a **SET NULL** pointer to the active version (a template with no published version is valid/draft).
- `email_sequence 1—N email_sequence_step` (FK `sequence_id`, **CASCADE** — delete-sequence drops steps).
- `email_sequence_step N—1 email_template` (FK `template_id`, **RESTRICT/SET NULL** — a step references a
  template **by id**, never copies it).
- `email_sequence 1—N email_enrollment` (FK `sequence_id`, **CASCADE**); `email_enrollment N—1 contacts`
  (FK `contact_id`, **CASCADE** — the canonical **Person**).
- `email_send N—1 contacts` (the **Person**, FK `contact_id`), `N—1 mailbox_integration` (FK
  `mailbox_integration_id`), `N—1 email_template_version` (FK `template_version_id`), and **optional**
  `N—1 email_enrollment` / `email_sequence_step` (a manual 1:1 send has none). All **references by id**.
- `email_tracking_event N—1 email_send` (FK `email_send_id`, **CASCADE** — events follow their send).
- `mailbox_integration N—1 sending_domain` (FK `sending_domain_id`, **SET NULL/RESTRICT**) — a mailbox
  sends **on** a tenant-authenticated domain (**D2**); `sending_domain` is **tenant**-scoped.
- `email_idempotency_key 1—1 email_send` (FK `email_send_id`, **SET NULL**) — the stored-response link
  (**D5**).
- `email_suppression` / `email_consent` `N—1 contacts` (FK `contact_id`, **CASCADE**) — but suppression
  also matches by `email_blind_index` / `domain` so a person with **no** local contact row is still gated.

> **The FK is not a workspace guard.** A foreign key proves the referenced row **exists**, not that it is
> in the **same workspace** — FK existence checks run with the table owner's privilege and bypass RLS
> (the explicit note on `lists.saved_search_id`, `lists.ts:58–62`, and `list_members.contact_id`). So
> every write path that accepts a client-supplied id (`contact_id`, `template_version_id`,
> `mailbox_integration_id`, `sequence_step_id`) **must re-validate that id under the caller's
> `withTenantTx`** in `emailRepository` (the `visibleContactIds` pattern, `listRepository.ts:126`) and
> reject/drop a foreign id — never rely on the FK for isolation.

### 4.2 ASCII sketch

```
                    ┌──────────┐
                    │ tenants  │  (tenant_id; CASCADE root; RLS key for sending_domain)
                    └────┬─────┘
                         │ 1:N
                    ┌────▼──────┐
                    │workspaces │  ◄── the RLS boundary (app.current_workspace_id)
                    └────┬──────┘
   ┌──────────────┬──────┴───────┬───────────────┬─────────────────┬────────────────┐
   │ 1:N          │ 1:N          │ 1:N           │ 1:N             │ 1:N            │
┌──▼───────────┐ ┌▼────────────┐ ┌▼────────────┐ ┌▼──────────────┐ ┌▼─────────────┐
│email_template│ │email_sequence│ │mailbox_     │ │email_         │ │email_consent │
│  (O)         │ │  (O)         │ │ integration │ │ suppression   │ │              │
│ current_     │ │              │ │  (O; secrets│ │ (D4; never    │ │ (lawful      │
│  version_id  │ │              │ │  _enc, D7)  │ │  purged)      │ │  basis)      │
└──┬───────────┘ └┬────────────┘ └┬────────────┘ └───────────────┘ └──────────────┘
   │1:N           │1:N            │ N:1 sending_domain (tenant-scoped, D2/D3)
┌──▼─────────────┐ ┌▼────────────┐  └──────────────┐
│email_template_ │ │email_       │                 │
│ version        │ │ sequence_   │   ┌─────────────▼──────────────┐
│ (subject/body) │ │ step        │   │      sending_domain        │
└──┬─────────────┘ └┬────────────┘   │ (tenant_id; SPF/DKIM/DMARC;│
   │                │ N:1 template   │  tracking_cname per D3)    │
   │                │                └────────────────────────────┘
   │           ┌────▼─────────┐
   │           │email_        │  N:1 contacts (Person)
   │           │ enrollment(O)│──────────────┐
   │           └────┬─────────┘              │
   │                │ 1:N (optional)         │
   │  template_     │                        ▼
   │  version_id    │              ┌──────────────────┐
   └────────────────┼─────────────►│   email_send (O) │  N:1 contacts (Person, by id)
                     │              │ subject_snapshot │  N:1 mailbox_integration
   email_idempotency_key 1:1 ───────┤ recipient_email_ │  N:1 email_template_version
   (D5; UNIQUE(ws, key))            │  enc + blind_idx │
                                    └────────┬─────────┘
                                             │ 1:N (CASCADE)
                                    ┌────────▼─────────┐
                                    │email_tracking_   │  open/click/reply/bounce/
                                    │ event            │  unsub/complaint/delivery
                                    └──────────────────┘
            contacts (the canonical Person — packages/db/src/schema/contacts.ts;
            email_enc / email_blind_index / deleted_at tombstone) is the DSAR anchor (§8).
```

- All workspace-scoped entities are `workspace_id`-keyed and **RLS-FORCED** — the isolation boundary is
  `workspaces`. `sending_domain` is `tenant`-keyed (a tenant-level reputation asset, **D2**/**D3**).
- The **canonical Person is the existing `contacts` row** (`contacts.ts`). The email subsystem **adds no
  new person table** — it references `contacts.id` and reuses `contacts.email_blind_index` /
  `contacts.deleted_at` for the suppression gate and the DSAR cascade.

---

## 5. Closed enums (mirrored in `@leadwolf/types`)

Each closed enum is a `check()` in `email.ts` whose values **mirror** `packages/types/src/email.ts`
(the source of truth, the `outreach.ts` idiom). The vocabulary:

- `email_template.status` ∈ `{ draft, active, archived }`; `email_template.category` ∈
  `{ prospecting, follow_up, nurture, transactional }`; `email_template.shared_scope` ∈
  `{ private, workspace }` (the **D8** sharing toggle).
- `email_sequence.status` ∈ `{ draft, active, paused, archived }`; `from_mailbox_strategy` ∈
  `{ owner, round_robin, fixed }` (mailbox-rotation, the Smartlead-style discipline `00 §6`, expressed
  per-tenant).
- `email_sequence_step.channel` ∈ `{ email }` (email-only this set, `00 §2` out-of-scope leaves room for
  more — same as `outreach_steps.channel`).
- `email_enrollment.status` ∈ `{ enrolled, active, paused, replied, completed, unsubscribed, bounced, failed }`
  (auto-pause-on-reply → `paused`/`replied`, **D9**).
- `email_send.status` ∈ `{ queued, sending, sent, delivered, bounced, failed, suppressed, canceled }`.
- `email_tracking_event.event_type` ∈ `{ delivery, open, click, reply, bounce, unsubscribe, complaint }`
  (**opens carried but de-emphasized — D6**; `is_mpp_suspected` flags Apple-MPP-prefetched opens, `04`).
- `mailbox_integration.provider` ∈ `{ google, microsoft, smtp, ses, postmark }` (the **D1** hybrid set);
  `status` ∈ `{ pending, connected, warming, error, disconnected }`; `warmup_state` ∈
  `{ none, warming, complete }`.
- `sending_domain.status` ∈ `{ pending, verifying, verified, failed, suspended }`; `dmarc_policy` ∈
  `{ none, quarantine, reject }`.
- `email_suppression.scope` ∈ `{ global, tenant, workspace }`; `match_type` ∈ `{ email, domain, contact_id }`;
  `reason` ∈ `{ unsubscribe, hard_bounce, complaint, manual, dnc, dsar }` (mirrors `suppression_list`,
  `billing.ts:128`).
- `email_consent.lawful_basis` ∈ `{ legitimate_interest, consent, contract, public_record }` (mirrors
  `consent_records.lawful_basis`, `compliance.ts:40`); `opt_state` ∈ `{ opted_in, opted_out, unknown }`.

---

## 6. Per-entity definitions

Each entry gives: **purpose**, **key columns** (scope columns implied per §3 unless noted),
**relationships**, **uniqueness/dedup**, **key indexes**, and **retention/DSAR**. The RLS shape is §3.2
for all; only deviations are noted.

### 6.1 `email_template` — the reusable, owner-scoped artifact

- **Purpose.** A named, versioned, owner-scoped, shareable subject+body artifact (`01`, **D8**). The
  template row is the **stable identity**; its content lives in versions (§6.2) so editing never mutates
  what an already-sent email rendered.
- **Key columns.** `tenant_id`, `workspace_id`, `owner_user_id`; `name`, `category`, `status`,
  `shared_scope` (**D8**), `current_version_id` (FK → `email_template_version.id`, **SET NULL** — the
  published "live" version), `archived_at`, `deleted_at`.
- **Relationships.** `1—N email_template_version` (CASCADE); referenced **by id** from
  `email_sequence_step.template_id` and (transitively) from `email_send.template_version_id`.
- **Uniqueness.** `UNIQUE(workspace_id, name)` **partial on `deleted_at IS NULL`** (a soft-deleted
  template frees its name — the `lists` partial-unique idiom).
- **Indexes.** `(workspace_id, status, updated_at DESC)` for the Templates tab list (`10`); `tenant_id`-leading.
- **Retention / DSAR.** Soft-delete + archive; hard-delete sweep per tenant retention. A template holds
  **no Person PII** (variables are placeholders, resolved at send) — so DSAR does **not** touch templates;
  only the rendered `email_send.subject_snapshot` is PII-bearing and is handled in §6.6.

### 6.2 `email_template_version` — the immutable point-in-time content

- **Purpose.** One immutable version of a template's `subject` + `body_html` + `body_text` +
  `variables`/fallbacks. New edits create a new `version_no`; published versions are **never mutated** so a
  sent email can always resolve the exact content it used (audit + render-safety, `01`).
- **Key columns.** `tenant_id`, `workspace_id`; `template_id` (FK CASCADE), `version_no`, `subject`,
  `body_html`, `body_text`, `variables` (jsonb — declared variable names + fallbacks), `is_published`,
  `created_by_user_id`, `created_at`.
- **Relationships.** `N—1 email_template`; referenced **by id** from `email_send.template_version_id`
  (the exact version a send rendered) and `email_sequence_step.template_id` (resolves to the template's
  current version at enqueue).
- **Uniqueness.** `UNIQUE(template_id, version_no)` (monotonic per template).
- **Indexes.** `(workspace_id, template_id, version_no DESC)`.
- **Retention / DSAR.** A version follows its parent template; a published version is **retained while any
  `email_send` references it** (don't orphan the record of what was sent). No Person PII (placeholders
  only) → not a DSAR target.

### 6.3 `email_sequence` — the cadence definition

- **Purpose.** An ordered, multi-step automated outreach flow (`05`), owner-scoped (**D8**). Carries the
  **CAN-SPAM identity** fields (`from_*`, `physical_address`) that are nullable here and **enforced at the
  send transaction** (the exact `outreach_sequences` posture, `outreach.ts:44`, `06`).
- **Key columns.** `tenant_id`, `workspace_id`, `owner_user_id`; `name`, `status`, `from_mailbox_strategy`,
  `physical_address` (CAN-SPAM), `auto_pause_on_reply` (bool, default true — **D9**), `archived_at`,
  `deleted_at`.
- **Relationships.** `1—N email_sequence_step` (CASCADE); `1—N email_enrollment` (CASCADE).
- **Uniqueness.** `UNIQUE(workspace_id, name)` partial on `deleted_at IS NULL`.
- **Retention / DSAR.** Soft-delete + archive; no Person PII (enrollments hold the Person links) → DSAR
  acts on enrollments (§6.5), not the sequence definition.

### 6.4 `email_sequence_step` — the ordered step

- **Purpose.** One step in a cadence: channel, delay, the template to send, and an optional branch
  condition (`05`). Mirrors `outreach_steps`.
- **Key columns.** `tenant_id`, `workspace_id`; `sequence_id` (FK CASCADE), `step_order`, `channel`
  (email-only this set), `delay_hours` (`>= 0` check), `template_id` (FK → `email_template`,
  **by id, not copied**), `branch_condition` (jsonb, e.g. on-no-reply), `created_at`.
- **Uniqueness.** `UNIQUE(sequence_id, step_order)` (the `outreach_steps` idiom).
- **Indexes.** `(workspace_id, sequence_id, step_order)`.
- **Retention / DSAR.** Cascades with the parent sequence; no Person PII.

### 6.5 `email_enrollment` — a Person enrolled in a sequence

- **Purpose.** One Person enrolled into one sequence, with lifecycle state and the scheduler cursor
  (`05`, `00 §4`). The `(sequence, contact)` pair **is** the enrollment-idempotency key (the
  `outreach_log` idiom) — enrolling the same Person twice is a no-op.
- **Key columns.** `tenant_id`, `workspace_id`, `owner_user_id`; `sequence_id` (FK CASCADE), `contact_id`
  (FK → `contacts.id`, the **Person**, CASCADE), `status`, `current_step`, `next_run_at` (the
  scheduler cursor — leader-locked tick, `05`/**D10**; the confirm-leader-locked-scheduler **known gap**),
  `paused_reason`, `enrolled_at`, `completed_at`.
- **Relationships.** `N—1 email_sequence`, `N—1 contacts` (Person); `1—N email_send` (each step send links
  back via `email_send.enrollment_id`).
- **Uniqueness.** `UNIQUE(sequence_id, contact_id)`.
- **Indexes.** `(workspace_id, next_run_at)` partial on `status IN ('enrolled','active')` — the
  scheduler's "due now" scan; `(workspace_id, sequence_id, status)` for the sequence dashboard.
- **Retention / DSAR.** High-volume → **monthly range-partition target** (the `outreach_log` /
  `source_imports` note — plain table until volume warrants; don't silently drop the partitioning intent).
  **DSAR (§8): an erasure dis-enrolls the Person from all unsent/active enrollments** (set
  `status='unsubscribed'`/`failed`, `next_run_at = NULL`) so no further mail can be scheduled to them
  (**D9**). The enrollment row is then soft-completed; hard-delete cascades when the contact is hard-deleted.

### 6.6 `email_send` — the single outbound email record

- **Purpose.** One outbound email — manual 1:1 from a mailbox, or an automated sequence-step send (`02`,
  `00 §4`). The **central, idempotent, suppression-gated** write of the subsystem.
- **Key columns.** `tenant_id`, `workspace_id`, `owner_user_id`; `contact_id` (Person, FK), 
  `mailbox_integration_id` (FK — sends **from** this mailbox), `template_version_id` (FK — the exact
  version rendered, **by id**), `enrollment_id` (FK, **nullable** — null for manual 1:1),
  `sequence_step_id` (FK, nullable), `sending_domain_id` (FK, the authenticated domain it went out on),
  `status`, `provider_message_id` (the ESP/mailbox message id, for webhook correlation), `queued_at`,
  `sent_at`, `failed_reason`. **Immutable point-in-time artifact columns** (the disciplined exception to
  references-not-copies, §1): `subject_snapshot` (the rendered subject actually transmitted) and
  `recipient_email_enc` (`bytea`, AES-GCM — the resolved recipient address at send time) +
  `recipient_email_blind_index` (`bytea` HMAC).
- **Why the snapshot exists.** The Person's contact row can change or be erased **after** the email is
  already in someone's inbox. The send must record **what was actually transmitted** for deliverability
  debugging, dispute handling, and bounce/complaint correlation — that is an operational/legal artifact,
  not denormalization. It is still **minimal** (subject + recipient address, **not** the full body — the
  body is reconstructable from `template_version_id`), and the recipient address is **encrypted**
  (`recipient_email_enc`) so the send row is not a plaintext-PII leak. (`02` owns the send write; `04`
  the body/preview policy.)
- **Relationships.** `N—1 contacts`, `N—1 mailbox_integration`, `N—1 email_template_version`, optional
  `N—1 email_enrollment` / `email_sequence_step`, `N—1 sending_domain`; `1—N email_tracking_event`
  (CASCADE); `1—1 email_idempotency_key` (the dedup row).
- **Uniqueness / dedup (D5).** The send is idempotent via `email_idempotency_key`
  `UNIQUE(workspace_id, idempotency_key)` (§6.12). The at-least-once BullMQ `email_send` queue
  (**D10**) inserts the idempotency row first; a retried job hits the unique constraint and returns the
  **existing** `email_send` rather than sending twice.
- **Indexes.** `(workspace_id, created_at DESC)` for the send feed; `(workspace_id, contact_id, created_at DESC)`
  for the per-contact timeline (`04`); `(tenant_id, provider_message_id)` for webhook correlation;
  `(workspace_id, recipient_email_blind_index)` for the DSAR fan-out (§8).
- **Retention / DSAR.** High-volume → **monthly range-partition target**. Retained per tenant retention,
  then hard-delete sweep. **DSAR (§8): null `recipient_email_enc` + `recipient_email_blind_index` and
  redact `subject_snapshot`** (the only PII-bearing fields), leaving the row as a referential anchor for
  audit until the retention hard-delete — exactly the `contacts` tombstone pattern (`contacts.ts:147`,
  "set + PII nulled").

### 6.7 `email_tracking_event` — the per-send engagement event

- **Purpose.** An open / click / reply / bounce / unsubscribe / complaint / delivery record tied to a
  send (`04`, `00 §4`). The raw signal behind reply-rate reporting (`08`) and the auto-pause-on-reply
  trigger (**D9**).
- **Key columns.** `tenant_id`, `workspace_id`; `email_send_id` (FK CASCADE), `event_type`, `occurred_at`,
  `provider_event_id` (the ESP/webhook event id, for idempotent ingestion), `is_mpp_suspected` (bool —
  flags Apple-MPP-prefetched opens so **D6** can de-emphasize them), `metadata` (jsonb — non-PII: clicked
  URL hash, bounce class, user-agent class; **never** message body or recipient PII), `created_at`.
- **Relationships.** `N—1 email_send` (CASCADE — events die with their send / its tombstone).
- **Uniqueness / dedup.** `UNIQUE(email_send_id, provider_event_id)` — the `email_tracking` ingestion
  queue (**D10**) is at-least-once; a re-delivered webhook is a no-op via `ON CONFLICT DO NOTHING`. Custom
  tracking host is **per-tenant** (`tracking_cname`, **D3**) so one tenant's tracking is never a shared
  blacklistable surface.
- **Indexes.** `(workspace_id, email_send_id, occurred_at)` for the per-send timeline;
  `(workspace_id, event_type, occurred_at DESC)` partial on `event_type='reply'` for the reply feed (the
  primary KPI, **D6**). Append-only, high-volume → **monthly range-partition target**.
- **Retention / DSAR.** Append-only; per-tenant retention then hard-delete. Holds **no recipient PII**
  (the send carries the recipient), so DSAR reaches it via **CASCADE from the send** — no per-event PII
  nulling needed.

### 6.8 `mailbox_integration` — the connected sending identity (secrets live here, D7)

- **Purpose.** A connected sending identity — Google/Microsoft OAuth or SMTP/ESP — owned by a user in a
  workspace (`02`, `00 §4`, **D1**). The **most sensitive** table: it holds live mailbox credentials.
- **Key columns.** `tenant_id`, `workspace_id`, `owner_user_id`; `provider`, `email_address` (display;
  the address itself is operational, not enrichable PII), `email_blind_index` (`bytea` HMAC — the dedup
  key), `status`, `oauth_tokens_enc` (`bytea`, AES-GCM, **D7** — access+refresh token blob),
  `smtp_secret_enc` (`bytea`, for SMTP/ESP), `sending_domain_id` (FK → `sending_domain`),
  `warmup_state`, `daily_send_limit` (the per-mailbox throttle, **D10**), `connected_at`,
  `disconnected_at`.
- **Secrets (D7, security precedence).** `*_enc` columns are **encrypted at rest** (AES-GCM today, **KMS
  target — the known gap**), **never returned to any client** (the repository projects them out of every
  DTO) and **never logged**. On disconnect the repository **zeroes the secret columns** while keeping the
  row (for send-history referential integrity).
- **Relationships.** `N—1 sending_domain` (sends **on** the tenant's authenticated domain, **D2**);
  `1—N email_send` (sends from this mailbox).
- **Uniqueness.** `UNIQUE(workspace_id, email_blind_index)` **partial on live rows** — one connection per
  address per workspace (blind index because the address is treated like PII for dedup, §3.4).
- **Indexes.** `(workspace_id, status)`; `(tenant_id, sending_domain_id)`.
- **Retention / DSAR.** Soft-disconnect (`status`, `disconnected_at`, secrets zeroed); hard-delete per
  retention. A mailbox address is the **sender**, not a data-subject of the tenant's prospects, so it is
  **not** a prospect-DSAR target; it is removed via the **owner's own account deletion** / tenant offboarding.

### 6.9 `sending_domain` — the tenant-authenticated sending domain (D2/D3)

- **Purpose.** A tenant-owned domain/subdomain authenticated for sending — SPF/DKIM/DMARC and the
  per-tenant custom tracking CNAME (`03`, **D2**, **D3**). The **reputation-isolation asset**: **no
  sending domain is ever shared across tenants** (**D2**), so this is the one **tenant-scoped** (not
  workspace-scoped) email entity.
- **Key columns.** `tenant_id` (the RLS key — §3.2); `workspace_id` (**nullable** — a domain may be
  tenant-wide or pinned to a workspace), `domain` (citext), `status`, `spf_verified`, `dkim_selector`,
  `dkim_verified`, `dmarc_policy`, `tracking_cname` (the per-tenant tracking host, **D3**),
  `dedicated_ip` (nullable — optional Reputation-Pool component, `00 §2` out-of-scope as a P0–P6
  deliverable), `verified_at`.
- **Relationships.** `1—N mailbox_integration`; referenced by `email_send.sending_domain_id`.
- **Uniqueness (the isolation invariant).** `UNIQUE(domain)` **globally** (no `tenant_id` in the key) —
  this is the database-level guarantee behind **D2**: the same sending domain can **never** be claimed by
  two tenants. (Verification of domain **ownership** is `03`'s DNS challenge; this constraint stops the
  double-claim regardless.)
- **Indexes.** `(tenant_id, status)`; the global `UNIQUE(domain)`.
- **Retention / DSAR.** Soft-delete; retained while any mailbox/send references it (don't orphan
  send-history). Not a prospect-DSAR target (it's tenant infrastructure).

### 6.10 `email_suppression` — the fail-closed do-not-send gate (D4)

- **Purpose.** An address/Person/domain blocked from sends (unsubscribe, hard-bounce, complaint, manual,
  DNC, DSAR), **checked tenant + workspace scoped on every send** (`06`, **D4**). The legal/reputational
  hard line; mirrors `suppression_list` (`billing.ts:110`).
- **Key columns.** `tenant_id` (nullable on global rows), `workspace_id` (nullable on tenant/global rows);
  `scope` (`global|tenant|workspace`), `match_type` (`email|domain|contact_id`),
  `normalized_email` (clear, lower/trimmed — the canon uniqueness key), `email_blind_index` (`bytea` HMAC,
  for the master-graph/DSAR fan-out match), `domain` (citext), `contact_id` (FK → `contacts.id`,
  CASCADE), `reason`, `created_by_user_id`, `created_at`.
- **Coherence checks (mirror `suppression_list`).** `scope ↔ id` coherence (global rows carry no
  tenant/workspace; workspace rows carry both) and `match_key_present` (the column named by `match_type`
  is non-null) — the exact `billing.ts:134/141` checks.
- **RLS deviation (read-side exposure).** Workspace-scope rows key on `workspace_id`; **tenant-scope and
  global-scope rows are visible to every scope under the tenant** so the **in-tx gate** sees them (the
  `suppressionRepository` read posture). Writes of tenant/global rows go through the audited platform path.
- **Uniqueness / dedup (D4).** `UNIQUE(tenant_id, workspace_id, normalized_email)` — **one suppression
  per (tenant, workspace, normalized_email)**; re-suppressing is a no-op. Tenant- and global-scope rows
  use the matching variants (`(tenant_id, normalized_email)` with workspace null; `(normalized_email)`
  global) — the `scope_coherence` check guarantees the right columns are populated.
- **Indexes.** `(workspace_id, email_blind_index)`, the tenant/global blind-index variants, and
  `(workspace_id, normalized_email)` — so the **gate is an index hit on every enqueue and dequeue** (D4
  checks **both**, `00 §3`).
- **Retention / DSAR.** **Never auto-purged** — suppression is durable legal memory. DSAR **adds** a
  `reason='dsar'` row (and a `global`-scope row for cross-tenant block, §8); it never removes suppression
  rows. The `email_send` gate consults this table **and** `contacts.email_blind_index` so an erased Person
  is blocked even with no local contact row.

### 6.11 `email_consent` — recorded lawful basis / opt state (D9)

- **Purpose.** The recorded lawful basis / opt state for contacting a Person in a jurisdiction (`06`,
  **D9**). Mirrors `consent_records` (`compliance.ts:15`) but in the email namespace and tied to the send
  gate.
- **Key columns.** `tenant_id`, `workspace_id`; `contact_id` (FK → `contacts.id`, CASCADE),
  `jurisdiction` (ISO-2), `lawful_basis`, `opt_state` (`opted_in|opted_out|unknown`), `source`,
  `valid_from`, `valid_until`, `withdrawn_at`, `recorded_by_user_id`, `created_at`.
- **Relationships.** `N—1 contacts` (Person). Consulted by the **same fail-closed send gate** as
  suppression (**D4**): a send lacking a valid basis / with `opted_out` is blocked.
- **Uniqueness.** `UNIQUE(workspace_id, contact_id, jurisdiction)` — the latest basis per Person ×
  jurisdiction (a withdrawal updates `withdrawn_at`/`opt_state`, it is a state change, not a new row).
- **Indexes.** `(workspace_id, contact_id)`.
- **Retention / DSAR.** Retained per compliance window. DSAR sets `opt_state='opted_out'` /
  `withdrawn_at` (the durable "do not contact" record), then the row cascades on contact hard-delete —
  but the **suppression** row (§6.10) is the part that outlives the contact and blocks re-import.

### 6.12 `email_idempotency_key` — the stored-response dedup row (D5)

- **Purpose.** The idempotency record that makes every send exactly-once against an at-least-once queue
  (**D5**, **D10**) — `Idempotency-Key` on the send create plus a **unique DB constraint**, with the
  stored response for replay (the `idempotency_keys` idiom, `billing.ts:152`, made workspace-scoped and
  linked to the send it created).
- **Key columns.** `tenant_id`, `workspace_id`; `idempotency_key` (the client/queue-supplied key),
  `response_status`, `response_body` (jsonb — the original API response, no PII beyond ids),
  `email_send_id` (FK → `email_send.id`, **SET NULL** — the send this key created), `created_at`.
- **Uniqueness / dedup (the whole point).** `UNIQUE(workspace_id, idempotency_key)` — a replayed key in
  the same workspace returns the **stored response** (and the linked `email_send`), never a second send
  (RFC 9457 / Idempotency-Key contract, `00 §5`). See the §2 note on why this is workspace- not
  tenant-scoped.
- **Indexes.** the `UNIQUE(workspace_id, idempotency_key)` serves the lookup; `(tenant_id, created_at)`
  for the TTL sweep.
- **Retention / DSAR.** **Short TTL** (the replay window — hours/days, not the send-retention window)
  then a sweep; `response_body` carries only ids, so it is not a DSAR target (the PII lives on the linked
  `email_send`, handled in §6.6).

---

## 7. The mandatory cross-tenant isolation itest (Phase 0 gate)

This is the **non-negotiable P0 gate** (`00 §8`, `13`): a real-Postgres integration test proving that
**tenant A can neither see nor modify tenant B's email rows**. Add
`packages/db/src/test/email.itest.ts`, modelled directly on `savedSearches.itest.ts` / the List tab's
`lists.itest.ts`. It runs against a real Postgres (Testcontainers by default, or `ITEST_DATABASE_URL`) in
its own process (the db client is a module singleton).

**Setup (mirrors the saved-search/list itest).** `applyMigrations(adminUrl)`, then seed via the
**BYPASSRLS admin connection**: two tenants × one workspace each — `tenantA/wsA/ownerA` and
`tenantB/wsB/ownerB` — plus a second member `coworkerA` of `wsA`. Seed each workspace with a full email
graph: a template + version, a sequence + step, a mailbox_integration (with encrypted secret bytes), a
sending_domain, an enrollment, a send, a tracking event, a suppression row, a consent row, and an
idempotency key.

**Assertions** (each cross-tenant assertion runs through `withTenantTx` as `leadwolf_app` under B's GUCs;
ground-truth "A is untouched" checks use the BYPASSRLS admin connection):

1. **Read isolation.** In scope B, every `emailRepository` list/find for templates, sequences, sends,
   tracking events, mailboxes, enrollments, suppression, consent returns **none** of A's rows.
2. **Write isolation.** In scope B, attempts to add a sequence step to A's sequence id, to enroll into A's
   sequence, to insert an `email_send` referencing A's `contact_id` / `mailbox_integration_id` /
   `template_version_id`, or to update A's send status all **no-op / 404** (RLS hides the row; the FK-not-a-guard
   re-validation drops the foreign id — §4.1). Verify via admin that A's rows are unchanged.
3. **Mutation isolation.** B's `update*` / `delete*` against A's ids no-op/404 — **no existence leak**.
4. **Suppression scope.** A `global`-scope suppression row is visible in **both** scopes (the §6.10 read
   exposure), but a **workspace**-scope suppression in wsA is invisible in wsB.
5. **Sending-domain uniqueness (D2).** Seeding the **same domain** for tenant B violates the global
   `UNIQUE(domain)` — proven at the DB level (no domain shared across tenants).
6. **Secret confidentiality (D7).** Every mailbox DTO the repository returns has the `*_enc` columns
   **projected out** (no ciphertext, no plaintext) — asserted on the read path.
7. **Owner-gating within a workspace (the app-layer half, D8).** `coworkerA` cannot edit/delete `ownerA`'s
   private template/sequence (owner-gated → not-found) but **can** see workspace-shared ones — mirrors the
   List tab's owner-gating case.
8. **Unscoped = nothing (fail-closed).** A `withTenantTx` with no `workspaceId` reads **zero** email rows
   (the `NULLIF(...,'')` GUC semantics).

> **Known gap to add (flag in the doc, per the constraints digest).** This db-level itest proves
> **RLS isolation at the data layer**. There is **NO per-endpoint cross-tenant HTTP isolation test** today
> — a test that drives the actual `apps/api/.../email` routes with tenant A's auth against tenant B's ids
> and asserts a 404. That HTTP-layer isolation test is a **named gap to add** (the same gap the
> constraints digest flags for the platform generally) — the db itest is necessary but not sufficient;
> the endpoint test catches a route that forgets to open `withTenantTx` or trusts a client id. Track it in
> `13` as a P0/P1 hardening item.

**DoD (per `13`/`00 §8`):** migrations apply; RLS proven `ENABLE`+`FORCE` on all twelve tables; the
isolation itest is green; **0 cross-tenant leaks**.

---

## 8. DSAR / deletion cascade (D9)

Per `06-compliance.md`, **ADR-0021** (`docs/planning/decisions/ADR-0021-global-master-graph-and-overlay.md`),
and the existing DSAR pattern (`compliance.ts`, `list-plan/08`), a data subject spans **every** tenant, so
erasure is the audited **platform fan-out** — run under `withPrivilegedTx`/`withPlatformTx` (never the
tenant flow), keyed off the **`subject_email_blind_index`** (the find-everywhere key, `compliance.ts:52`).
The cascade reaches the email subsystem because email rows reference the canonical **Person**
(`contacts.id`) and carry blind-index columns the fan-out can match. For each matched Person, in every
workspace:

1. **Tombstone the Person.** Existing step — set `contacts.deleted_at` and null the PII
   (`email_enc`, `email_blind_index`, name) — the documented `contacts` tombstone. This is the anchor;
   the email entities follow.
2. **Dis-enroll.** Resolve all `email_enrollment` rows for the Person to a terminal state
   (`status='unsubscribed'`, `next_run_at = NULL`) so **no further send can be scheduled** (§6.5, **D9**).
3. **Redact sends.** For every `email_send` of the Person, **null `recipient_email_enc` +
   `recipient_email_blind_index` and redact `subject_snapshot`** (the only PII-bearing fields), leaving the
   row as a referential anchor until the retention hard-delete (§6.6). `email_tracking_event` rows carry no
   recipient PII and follow via **CASCADE** when the send is hard-deleted.
4. **Withdraw consent.** Set `email_consent.opt_state='opted_out'` / `withdrawn_at` for the Person (§6.11).
5. **Suppress to block re-contact + re-import.** Insert an `email_suppression` row with `reason='dsar'`,
   matched by `email_blind_index`, and — for cross-tenant erasure — a **`global`-scope** row (§6.10). Because
   the suppression gate runs **in-tx on every send** and global rows are visible to every scope, a
   re-uploaded/re-enriched copy of the erased Person is **gated before any mail can leave** — the durable
   "do not re-create / do not re-contact" memory (the exact `list-plan/08 §5.2` mechanism).
6. **Audit.** The erasure writes `dsar.delete` to the customer-visible `audit_log` (the verb exists,
   `billing.ts:194`) and the platform fan-out writes its `platform_audit_log` row in the same tx — **ids +
   actions only, never PII or message bodies** (the audit posture, `00 §5`).

**How the cascade *finds* every email reference (the digest's "find ALL tenant references" rule).** The
fan-out does not enumerate sequences/lists; it resolves by the **blind index**:
`contacts.email_blind_index` → all `email_enrollment.contact_id` / `email_send.contact_id` /
`email_consent.contact_id` for that Person in every workspace, **plus** any `email_send` /
`email_suppression` matched directly by `recipient_email_blind_index` / `email_blind_index` (covering sends
to an address with no local contact row). One identity → fan out to every email overlay — the same
"deletion provable via the golden identity" property ADR-0021 gives Lists.

**The DSAR-cascade itest (P6, owned by `13`; complements §7).** Seed the same Person enrolled + sent-to in
two workspaces, run the platform erasure, and assert: enrollments terminal + `next_run_at` null, sends'
recipient PII nulled + subject redacted, tracking events resolved (cascade or orphan-safe), consent
`opted_out`, a `dsar` (and `global`) suppression row present, and a re-enroll/re-send of the erased Person
is **blocked by the suppression gate**.

---

## 9. Summary of changes (the `db` / `types` Phase-0 work)

| File | Change |
|---|---|
| `packages/db/src/schema/email.ts` | **New.** All twelve entities (§6) with the local column-factory idioms, `bytea`/`citext` `customType` helpers, closed-enum `check()`s mirroring `types/src/email.ts`, partial-live unique indexes, scope-coherence checks (suppression), and `tenant_id`-leading composite indexes. |
| `packages/db/src/rls/email.sql` | **New.** `ENABLE`+`FORCE` + one isolation policy per table (workspace-keyed; `sending_domain` tenant-keyed; `email_suppression` with the tenant/global read exposure), `set_updated_at()` triggers, closing `GRANT … TO leadwolf_app`. Idempotent. |
| `packages/db/src/repositories/emailRepository.ts` | **New.** The sole data-access layer — tx-aware methods; FK-not-a-guard re-validation of every client id (the `visibleContactIds` pattern); secret columns projected out of every DTO (**D7**); the in-tx suppression+consent gate composition. |
| `packages/types/src/email.ts` | **New.** Zod source of truth — the closed enums (§5) and the DTOs/cursor-paginated reads; the schema `check()`s mirror this file. |
| `packages/core/src/email/` | **New.** Framework-free render/scheduling/gate logic over the repository. |
| `packages/db/src/test/email.itest.ts` | **New.** The two-tenant cross-tenant isolation itest (§7); the DSAR-cascade itest lands in P6 (§8). |
| `packages/db/migrations/00NN_*.sql` | **Generated** by `bun run db:generate` (then `db:migrate`) — do not hand-edit; the meta snapshot stays in lockstep (the `list-plan/02 §2.3` migration discipline). |
| `packages/db/src/schema/billing.ts` (`audit_log`) | **No enum change** — `send`, `enroll`, `unsubscribe`, `suppression.add/remove`, `consent.record/withdraw`, `dsar.*`, `template.*`, `sequence.*` verbs already present (`billing.ts:189–207`). |

> **Known gaps carried forward** (the constraints digest, restated so they are not lost): KMS not yet
> wired — secrets use **app-AES-GCM + blind index today** (**D7** target); **no per-endpoint cross-tenant
> HTTP isolation test** — add it (§7); per-tenant quota gates unwired and confirm the **leader-locked
> scheduler** for the enrollment tick (§6.5) — tracked in `13`; multi-region residency siloing absent
> (`00 §2` out of scope).

---

**Sources (schema-pattern claims):**

- [HubSpot: Understand email sending in HubSpot](https://knowledge.hubspot.com/marketing-email/understand-email-sending-in-hubspot) — validates the mailbox-vs-relay split (**D1**) and per-tenant authenticated sending domains the entity model encodes.
- [Google: Email sender guidelines](https://support.google.com/a/answer/81126) — the SPF/DKIM/DMARC + one-click-unsubscribe + < 0.30% complaint floor behind `sending_domain`, `email_suppression`, and `email_consent`.
- [Mailchimp: Apple Mail Privacy Protection (MPP) FAQs](https://mailchimp.com/help/apple-privacy-faq/) — the open-inflation reality behind `email_tracking_event.is_mpp_suspected` and **D6** (reply rate, not opens).
