# List Tab — Security & Compliance (08)

> Cites the **Locked Decisions (D1–D5)** and **Shared Vocabulary** in `00-overview.md` (verbatim, not
> re-litigated) and the phase mapping in `09-rollout-phases.md`. Governance citations `[n]` index the
> source list in `01-research-summary.md § Sources`; the per-control industry baseline lives in
> `01-research-summary.md §F` — referenced here, not re-pasted. Cross-references `02-data-model.md`
> (schema/RLS/DSAR cascade — being authored in parallel) and `07-admin-staff-governance.md` (the staff
> capability matrix). **This is an engineering-controls design, not legal advice — privacy counsel must
> review before any production launch with real data** (`docs/planning/08-compliance.md` preamble).

This document is the **security & compliance contract** for the List tab: how uploaded and collected list
data stays isolated, encrypted, lawfully processed, deletable, and gated against contact of suppressed
subjects. Nothing here is greenfield — the List tab **inherits** the existing isolation (RLS), PII
encryption, suppression, DSAR-fan-out, and audit machinery and **extends** it to `lists` / `list_members`
and the import-into-list path. Where a control already exists we cite the code; where the List tab adds a
surface, the rule is stated as a build mandate for **Phase 5** (`09 §2`).

---

## 1. Tenant / workspace isolation (D1 / D4)

### 1.1 The boundary is Postgres RLS, below the app layer

Per **D4** (`00 §3`), the hard isolation boundary is **Postgres Row-Level Security**, unchanged by this
plan. List ownership and "my lists" are **filters** in the repository/core layer, **never** a new access
wall. This follows the AWS SaaS *isolation-mindset* tenet — never rely on application code alone to keep
tenants apart (`01 §F.2` [28], [29]).

Every tenant-owned query runs through **`withTenantTx`** (`packages/db/src/client.ts`), the *only*
sanctioned scoped-query path. It:

1. `SET LOCAL ROLE leadwolf_app` — drops to the **non-`BYPASSRLS`** app role for the transaction, so RLS is
   actually enforced even when the base connection is privileged (the documented dev/superuser case);
2. sets the GUCs `app.current_tenant_id` and `app.current_workspace_id` **`LOCAL`** to the transaction
   (RDS-Proxy / PgBouncer transaction-pooling resets them per checkout, so they must be set in-tx),
   collapsed into a single bound `set_config()` round-trip.

Both the role and the GUCs are transaction-local and the values stay **bound** (no string concat).

### 1.2 Two-tier scoping, fail-closed via NULLIF

Lists/list_members mirror `contacts` exactly. `rls/lists.sql` already ships the policy
(`packages/db/src/rls/lists.sql`):

```sql
ALTER TABLE lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE lists FORCE ROW LEVEL SECURITY;          -- writer is leadwolf_app → FORCE applies the policy to it
CREATE POLICY lists_workspace_isolation ON lists
  USING      (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
-- identical policy on list_members; GRANT SELECT,INSERT,UPDATE,DELETE … TO leadwolf_app
```

The **`NULLIF(current_setting(…, true), '')`** idiom is the fail-closed core: an **unset OR `''`-reset**
GUC evaluates to `NULL`, the predicate `workspace_id = NULL` is never true, and an unscoped query
**reads/writes nothing** rather than leaking. `FORCE` is correct here because the writer is the
`leadwolf_app` role itself (contrast `platform_audit_log`, which is `ENABLE`-not-`FORCE` because its writer
is the table owner — `rls/platform.sql`). RLS guarantees the hard property: **workspace A can never see
workspace B's lists or members.** `tenant_id` is carried (denormalized) for tenant-scoped tables and as a
defence-in-depth column; `workspace_id` is the operative isolation key (ADR-0006).

> **Phase 0 build mandate** (`09 §2`): extend `rls/lists.sql` already exists for the base tables; add the
> same `ENABLE + FORCE + NULLIF` policy to any new list-side table (`02-data-model.md`), and ensure
> `source_imports` (the import provenance) keeps its existing contacts-mirroring policy
> (`rls/contacts.sql`) when an import targets a list.

### 1.3 The strict-isolation guarantee (D1)

**D1** locks the strongest property: **a customer's uploaded list data is theirs alone and never feeds the
shared/global master graph.** Two distinct invariants compose it:

- **Workspace isolation** (RLS, §1.2): uploaded rows live in exactly one workspace's overlay; no
  cross-workspace read/write.
- **Match-against ≠ contribute-to** (ADR-0021, `06-enrichment-engine.md §1`): we **MATCH-AGAINST** the
  master graph for *that customer's own* dedup + enrichment (always allowed — it sets the overlay's
  `master_person_id`), but **CONTRIBUTE-TO is OFF** — no co-op, no opt-in to contribute in this plan.
  Uploaded field values are **never** promoted into a golden record other workspaces could read. This is a
  **deliberate divergence** from the contributory/co-op model that ZoomInfo Community Edition and Apollo's
  Living Contributor Network run (`01 §F.1` [23], [24], [25]) — not a gap to close.

> **Phase 0 build mandate — the isolation-guarantee itest** (`09 §2`, modelled on
> `packages/db/test/savedSearches.itest.ts`): two workspaces + multiple owners; assert that list
> read/write, member add/remove, import-into-list, and every bulk op **never cross
> `app.current_workspace_id`**, and that an unscoped (`workspace_id` GUC unset) read returns **zero rows**.
> This is the executable proof of the D1/D4 boundary; success metric: **0 cross-tenant leaks** (`00 §6`).

---

## 2. PII handling — encryption, blind index, masking, reveal

### 2.1 App-layer AES-GCM encryption at rest

PII on `contacts` is encrypted **at the app layer** before it touches the database — the DB ideally never
sees plaintext PII (`08-compliance.md §9`). `packages/db/src/schema/contacts.ts`:

- `email_enc bytea` — AES-GCM ciphertext of the email; **masked until reveal**.
- `phone_enc bytea` — AES-GCM ciphertext of the phone; **masked until reveal**.

Keys are KMS-wrapped (envelope encryption) with rotation; no secret reaches the client (`NEXT_PUBLIC_*` is
public — security skill *Core Non-Negotiables*; `08-compliance.md §9`). This satisfies the DPA's
**AES-256 / TLS-1.3** technical-measure clause (`01 §F.3` [31]). Imported list rows land through the
**same** encrypted columns — there is **no plaintext-PII storage path** for uploaded data, and the
rejected-rows artifact (which echoes raw PII) is a short-TTL, access-controlled, presigned-URL-only,
DSAR-purgeable object (`08-compliance.md §9`).

### 2.2 Blind index — dedup without plaintext

Because a unique constraint cannot run over ciphertext, per-workspace email uniqueness/lookup uses a
**deterministic blind index**: `email_blind_index bytea = HMAC(normalized email)`, backing the partial
unique index `uniq_contacts_ws_email (workspace_id, email_blind_index)`. This is what lets the
import-into-list path **dedup against existing members and suppression-screen** (§6) **without ever
decrypting**. `suppression_list.email_blind_index` and `phone_blind_index` use the **same** HMAC so the
set-based suppression anti-join matches by blind index, never plaintext (`billing.ts`,
`08-compliance.md §3.1`).

### 2.3 Masked-by-default; reveal is the only de-masking path

Search/list views **never carry PII to the client** — masking is the default everywhere, including the List
tab's members table (which reuses the prospect `DataTable` masking — `09 §2`). **Reveal is the only
de-masking path**: it decrypts `email_enc`/`phone_enc` in the reveal (and send) path only, is per-workspace
first-reveal-wins and idempotent, and is **suppression-gated in-transaction** (ADR-0007, D5; §6 below).
Exports carry only **revealed, owned** fields and are a set-based anti-join against suppression
(`08-compliance.md §3.2`); staff record-level access to masked content requires break-glass (§ stated in
`07-admin-staff-governance.md`, D2). **Charge only for matched/valid data; credit-back on hard bounce**
(D5, ADR-0013) ties the money rule to verification, mirroring Lusha's "unmatched = 0 credits" (`01 §B`
[10]) and Apollo's estimate-before-run (`01 §G.1` [1]).

---

## 3. GDPR

### 3.1 Lawful basis — B2B legitimate interest + documented LIA

For B2B prospecting the lawful basis is **legitimate interest (GDPR Art. 6(1)(f))** with a **documented
balancing test (LIA)**, or explicit consent where required (`01 §F.3` [30]; `08-compliance.md §2`). We
store a **`consent_records`** row per contact × jurisdiction capturing `lawful_basis`, `source`, validity
window, and any withdrawal (`packages/db/src/schema/compliance.ts`). For uploaded lists, a **lawful-basis
attestation is recorded per import** at ingest (the `source_imports` lawful-basis snapshot,
`08-compliance.md §11`, `21 §5.1`) — the customer attests the basis under which the list was collected,
forming the queryable lawful-basis lineage chain for DSAR/audit. The published **privacy notice** explains
sources, purposes, lawful basis, and how to exercise rights (`08-compliance.md §2`).

### 3.2 Controller vs processor

The split is explicit for uploaded list data:

- **The customer is the controller** of the prospects in **their uploaded list** — they decided to collect
  those people and they attest the lawful basis at import (§3.1).
- **TruePoint is the processor** for that uploaded list — we process it **on instruction only** to deliver
  dedup/enrichment/verification/reveal *for that customer*, and **do not** mix it into the shared graph
  (D1, §1.3). (For the master graph we build from providers/registries, TruePoint is itself a
  **controller** and a registered **data broker** — but that is the separate Layer-0 surface, ADR-0021;
  the uploaded-list relationship is processor-only.)

### 3.3 DPA Article-28 obligations

For the customer-as-controller relationship we honour the **Art. 28 / nine-element** processor obligations
(`01 §F.3` [31]):

| Obligation | How the List tab honours it |
|---|---|
| **Instruction-only processing** | Uploaded list data processed only to deliver the customer's own dedup/enrich/verify/reveal; never repurposed. |
| **No secondary AI training on customer data** | Reinforced by **D1** (no contribution) and `08-compliance.md §10`: AI (Anthropic Claude, a sub-processor under DPA) is grounded in revealed/owned data only; **no customer data trains any model** without explicit terms. `ai_requests` logs are in DSAR scope. |
| **Sub-processor 30-day notice + objection** | Published sub-processor list (enrichment providers, Stripe, AWS/SES, Anthropic) with **≥30-day change notice** and a customer **objection** right (`08-compliance.md §10`, §15 Trust Center). |
| **Breach notification 48–72h** | GDPR Art. 33 regulator notice ≤72h; customer notice per DPA terms (here targeted 48–72h). Owned by the `compliance_officer`; runbook + counsel-approved templates (`08-compliance.md §16`). |
| **AES-256 / TLS-1.3 technical measures** | §2.1 encryption + TLS in transit. |
| **Export / delete at termination** | 30-day export / 60-day delete of customer data at contract end; per-workspace export and deletion are trivial under the per-workspace overlay (ADR-0006). |

---

## 4. CCPA / CPRA

CCPA/CPRA **cover business-contact PII** — there is **no B2B exemption** to rely on (`01 §F.3` [30]). A
data subject's **"Do Not Sell / Share" opt-out** (and any CCPA-equivalent objection) **auto-inserts a
`global`-scope `suppression_list` row** (gating reveal **and** send) and withdraws the matching consent
record (`08-compliance.md §2`). Because TruePoint operates a global master graph it is squarely a **data
broker**, so the **California Delete Act / DROP** platform is a **second deletion intake channel** alongside
self-serve DSAR: a scheduled job **polls DROP ≥ every 45 days** and routes matches into the **same
`dsar-delete` fan-out** as any erasure (§5; `08-compliance.md §4.4`, §15). Uploaded list data is in scope
of that fan-out like any overlay copy — no list-specific opt-out path is needed.

---

## 5. DSAR / right-to-erasure (≤30 days)

DSARs (access / delete / rectify) are fulfilled **within ≤30 days, including backups** (`01 §F.3` [32]),
via self-serve intake + admin workflow, with requester identity verified first (`08-compliance.md §4`).
Data: `dsar_requests` (`packages/db/src/schema/compliance.ts`). The deletion cascade as it applies to
**uploaded list data** (full schema-level detail in `02-data-model.md`):

### 5.1 List deletion vs person erasure — two different operations

- **List delete** (a customer deleting their own list) is an **ordinary tenant operation** under RLS: it
  **cascades `list_members`** (membership rows removed) but does **not** delete the underlying `contacts`
  (a contact may belong to other lists, be revealed, or be owned). It is audited as `list.delete`
  (`08-compliance.md §5` closed enum) via `withTenantTx`. This is *removal from a list*, not erasure of a
  person.

- **Person-level erasure** (a DSAR/DROP/opt-out for a human) is the **privileged fan-out** and is the one
  that must reach *everywhere*, list membership included.

### 5.2 The erasure cascade (the hard one)

A single idempotent, verifiable `dsar-delete` BullMQ job (`08-compliance.md §4.2`), run under the **one
sanctioned cross-workspace path** — `withPrivilegedTx` / the audited DSAR role in `client.ts`, **never** the
tenant request flow:

1. **Resolve the golden identity** in the master graph (by blind index / LinkedIn id) → `master_person_id`
   (ADR-0021 makes "find everywhere" *provable* from one identity).
2. **Purge the master record** — tombstone `master_persons` + `master_emails`/`master_phones` +
   `source_records` + `match_links`, so the ER pipeline can't re-form the cluster.
3. **Cascade to every overlay copy** across all workspaces/tenants: **tombstone + null PII** — set
   `contacts.deleted_at`, null `email_enc`/`phone_enc`/name (the `deleted_at` column is exactly the DSAR
   tombstone documented in `contacts.ts`); **purge `source_imports`, `contact_reveals`, `activities`,
   `outreach_log`, `provider_calls`, Redis entries**; and **remove the subject's `list_members` rows** so
   no list still references the erased person (list membership is an overlay dependent, swept by the same
   cascade — `02-data-model.md`).
4. **Add a `global`-scope `suppression_list` row** (and set `master_persons.is_suppressed`) so no source,
   co-op, re-import, or re-enrichment re-creates the subject and **no future list upload can re-introduce
   them** (the import-time suppression screen, §6, enforces this).
5. **Audit** the deletion append-only (one row per master + overlay touched; `dsar.delete`).
6. **Verification scan** — the job is not `completed` until a scan confirms **no residual PII** across the
   master record + `source_records` + **all** overlay copies + their dependents (`list_members`,
   `source_imports`, reveals, activities) + caches.

> **Phase 5 build mandate** (`09 §2`): the **DSAR-cascade itest** must prove that a person-level erasure
> tombstones the contact across copies, **removes `list_members`**, purges source_imports/reveals/
> activities, and **inserts the `global` suppression row** — success metric: **DSAR deletion provably
> cascades** (`00 §6`). Cost/SLA vs. number of overlay copies + master shards is an **open question**
> ADR-0021 explicitly flags (§7 below; `08-compliance.md §13.5`).

---

## 6. DNC / suppression (TCPA)

**Suppression is unbypassable** (`08-compliance.md §1.1`): the suppression check runs **inside** the reveal
**and** the outbound-send transaction, not as a pre-guard — no code path can reveal or message a suppressed
contact (`assertNotSuppressed`, ADR-0009). The List tab extends this to **list bulk ops** (`09 §2`,
Phase 5):

- **Scopes:** `global` (a subject's GDPR objection / CCPA opt-out / hard bounce / complaint), `tenant`, and
  `workspace` — enforced by the `suppression_list` scope-coherence CHECK (`billing.ts`).
- **Match types:** `email`, `domain`, `phone`, `contact_id`, all by **blind index** (§2.2) — never
  plaintext.
- **Reveal & bulk-reveal gating (D5):** every list-member reveal — single or bulk — runs the same in-tx
  `assertNotSuppressed` before any reveal or charge; a suppressed row is **never revealed, exported, or
  charged** and the attempt is audited (`reveal.blocked`). Bulk reveal is "the single reveal path run many
  times" — **no new compliance mechanism** (`08-compliance.md §17`).
- **Import-time screening (set-based):** every imported list row is screened against suppression/DNC **at
  ingest in a single set-based join** over the staging table, **before** any row is used, enriched, or
  charged; suppressed rows are **dropped from the usable set** (routed to the rejected-rows artifact with a
  `suppressed` reason) and never enriched/charged (`08-compliance.md §3.1`). A `global` row excludes the
  subject from **every** import — the §5.2 re-import guard.
- **Export-time:** a set-based anti-join of the revealed/owned set against suppression, bounded by the
  workspace's reveal count (`08-compliance.md §3.2`).

**Re-scrub cadence (TCPA / DNC):** the industry baseline is **scrub ≥ every 31 days + suppression on
opt-out** (`01 §F.3` [33]); the data-decay research independently recommends **re-verify active lists
monthly, databases quarterly** (`01 §E` [21]). The List tab adopts the stricter operational posture:
**list bulk reveal/contact paths consult live suppression in-tx (always current)**, and a scheduled
**re-scrub job sweeps active lists on a ≤31-day cadence** against the latest `global`/`tenant`/`workspace`
suppression rows, plus **hard-bounce → immediate suppression + remove** (`01 §E` [21],
`08-compliance.md §6`). Phone fills in any bulk batch honour the same DNC/consent controls
(`08-compliance.md §17`).

---

## 7. Retention (storage-limitation)

Inherits the chosen posture: **retain per-workspace copies while lawful + in use, with periodic
re-verification; purge on DSAR/suppression** (`08-compliance.md §7`). Proposed posture for uploaded lists +
their audit:

| Data class (List tab) | Retention | Mechanism |
|---|---|---|
| `lists` / `list_members` | Retained while the list is live + lawful | Purged on list delete (members) or DSAR (member rows for the erased subject, §5.2); optional `archived_at` soft-archive (`09 §2` Phase 0) |
| `contacts` reached via list membership | Retained while lawful + valuable | Periodic re-verification (§6 cadence); purge on DSAR/suppression |
| `source_imports` (import-into-list provenance) | Retained for provenance | Older monthly partitions archived to S3 (encrypted); **PII purged on DSAR** |
| List `audit_log` events (`list.create/update/delete`, member-add/remove, bulk-action) | Long retention (compliance) | Monthly partitions; append-only; policy-defined window |
| Rejected-rows import artifact (echoes raw PII) | Short-lived | Short TTL + access-controlled presigned URL + purge on DSAR (`08-compliance.md §9`) |
| Quarantined uploads (pre-scan) | Transient | Deleted on clean-and-imported or on infected verdict (`08-compliance.md §9`) |

Re-verification serves the accuracy principle; suppression + DSAR provide the erasure path. **Exact windows
are confirmed with legal** (`08-compliance.md §7`, §13.1). **Open question (ADR-0021):** DSAR cost/SLA
scales with the number of **overlay copies + master shards** the verification scan must sweep — list
membership adds another dependent to the cascade; tracked as `08-compliance.md §13.5`.

---

## 8. Roadmap (not built here)

Enterprise follow-ons, explicitly **out of scope for this plan** (`00 §2`), listed with one-line rationale:

- **BYOK (bring-your-own-key)** — let an enterprise tenant supply/rotate its own KMS key wrapping its PII,
  so TruePoint can technically be excluded from decrypting their list PII (the strongest processor posture).
- **Multi-region data residency** — stand up an EU region and route EU data subjects' PII there; the schema
  already **tags** every PII-bearing record with `region`/`jurisdiction` so the routing is deterministic
  and no reshape is needed (`08-compliance.md §8`; ADR-0006 data-residency note).
- **SOC 2 Type II (+ ISO 27001)** — external attestation that converts the privacy-first posture (RLS
  isolation, append-only audit, KMS encryption, break-glass) from a promise into a verifiable moat
  (`08-compliance.md §15`; ADR-0014). Readiness begins at M5; external audit follows post-MVP.

---

## 9. Compliance test matrix

The itests/checks that **must pass** before the List-tab governance work is GA-ready (`09 §5`; `00 §6`
success metrics). Modelled on `packages/db/test/savedSearches.itest.ts` and run in `packages/db/test`:

| # | Test | Asserts | Phase |
|---|---|---|---|
| 1 | **Isolation guarantee** | Two workspaces + multiple owners; list read/write, member add/remove, import-into-list, and every bulk op **never cross `app.current_workspace_id`**; an unscoped GUC read returns **zero rows** (NULLIF fail-closed). **0 cross-tenant leaks.** | 0 |
| 2 | **Staff-no-access** | Without an active **impersonation session** (`impersonation_sessions`), a staff/platform path sees **zero** list-member PII rows — only metadata + aggregate (D2). Record-level access requires break-glass; start/end each write a `platform_audit_log` row (append-only, `rls/platform.sql`). | 5 |
| 3 | **DSAR / erasure cascade** | A person-level erasure tombstones the contact across copies (`deleted_at` + nulled `email_enc`/`phone_enc`/name), **removes the subject's `list_members`**, purges `source_imports`/`contact_reveals`/`activities`, inserts a **`global` `suppression_list` row**, and the **verification scan finds no residual PII**. | 5 |
| 4 | **Suppression gating** | A `global`/`tenant`/`workspace` suppression hit blocks **reveal and bulk-reveal** of a list member in-tx (no credit charged; `reveal.blocked` audited) and **drops the row at import ingest** (set-based screen, `suppressed` reason); a suppressed subject can **never** be re-imported into a list. | 5 |
| 5 | **Encryption-at-rest** | List-member PII is stored only as `email_enc`/`phone_enc` ciphertext (no plaintext column); dedup/uniqueness/suppression match by `email_blind_index` (HMAC) with **no decryption**; reveal is the only de-masking path. | 2 / 3 |
| 6 | **Import dedup (idempotent)** | Re-importing the same content into the same workspace/list adds nothing new (`source_imports.content_hash` partial-unique idempotency; `list_members` honour per-workspace contact dedup). | 2 |

**Gate (every phase, `09 §5`):** `npx turbo run typecheck`, `bun test`, `npx @biomejs/biome check`,
`npm run lint:boundaries`, and regenerate `docs/ARCHITECTURE_MAP.md`.

---

## 10. Cross-references

- `00-overview.md §3` — Locked Decisions **D1–D5** (canonical; cited throughout).
- `02-data-model.md` — schema for `lists`/`list_members`, the RLS extension, and the full DSAR-cascade
  column-level detail this doc references (§1.2, §5).
- `07-admin-staff-governance.md` — the **privacy-first staff capability matrix** (D2), break-glass
  impersonation, `platform_audit_log` extension for list ops, and the customer-visible access log (§2, §6
  staff line).
- `09-rollout-phases.md §2` — Phase 0 (isolation itest), Phase 2 (encrypted import + dedup), Phase 3
  (suppression-gated bulk reveal), Phase 5 (staff governance + DSAR cascade).
- `docs/planning/08-compliance.md` — the product-wide compliance design this doc specialises to lists.
- ADRs: **ADR-0021** (master-graph / overlay; match-against ≠ contribute-to; DSAR cascade),
  **ADR-0006** (per-workspace model + RLS), **ADR-0007** (per-workspace reveal + credit),
  **ADR-0013** (charge-for-valid / credit-back), **ADR-0009** (in-tx suppression), **ADR-0011 / ADR-0032**
  (platform admin, impersonation, append-only `platform_audit_log`), **ADR-0014** (trust & certification).
