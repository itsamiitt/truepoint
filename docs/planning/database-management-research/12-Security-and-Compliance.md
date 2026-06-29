# 12 — Security & Compliance

> **Series:** [Database Management](./README.md) · **Type:** Design · **Status:** ✅ Authored ·
> **Prev:** [`11-Roles-and-Permissions`](./11-Roles-and-Permissions.md) · **Next:**
> [`13-Performance-and-Scaling`](./13-Performance-and-Scaling.md)

---

> **Precedence note (CLAUDE.md).** **Security has the final say on whether something is safe.** This
> document is the binding control layer for the entire Database-Management programme. Where any sibling
> doc — [04-Control-Panel-Architecture](./04-Control-Panel-Architecture.md),
> [05-Upload-Pipeline-Design](./05-Upload-Pipeline-Design.md),
> [09-Review-and-Approval-System](./09-Review-and-Approval-System.md),
> [11-Roles-and-Permissions](./11-Roles-and-Permissions.md) — proposes a data path, **the rule here
> governs whether that path may ship.** A multi-tenant write without an RLS-enforced *or*
> structurally-isolated, ownership-checked, capability-gated, audited path is a **bug**, not a style
> choice. Platform owns the tenancy mechanism (RLS); Data owns the model and ownership semantics;
> Security enforces both.

---

## 1. Objective

Define the complete security and compliance posture for operating the **Surface 1 Internal Staff Data
Console** (a new `Data management` nav group in `apps/admin`) and the **Surface 2 Customer
Self-Service** data panel (`apps/web/src/features/data-health`). The console is **cross-tenant by
design** — staff act *on behalf of the platform*, reaching into every tenant's data. That makes it the
single highest-blast-radius surface in TruePoint, and therefore the one where every read and every
write must be **(a) capability-gated, (b) routed through an audited cross-tenant transaction wrapper,
(c) recorded immutably, and for high-risk operations (d) JIT-elevated and (e) maker/checker-approved.**

Concretely, this document specifies and makes binding:

1. **Tenant isolation** — RLS via `withTenantTx` (the `NULLIF` fail-closed predicate, `FORCE ROW LEVEL
   SECURITY`), structural Layer-0 isolation via `withErTx` (no overlay grant), and the **audited
   cross-tenant** path via `withPlatformTx` (writes `platform_audit_log` *in the same transaction*).
2. **Why the panel never uses the tenant request flow** — every data-ops read/write is `withPlatformTx`
   + `requireCapability`, never `withTenantTx` with a client-supplied scope.
3. **PII at rest and in motion** — AES-GCM `email_enc`/`phone_enc`, HMAC blind indexes, the
   reveal model (`is_revealed` / `revealed_by_user_id`), masking in the console.
4. **Residency & lawful basis** — India DPDP, GDPR Art. 14 source-notice, TCPA/DNC `phone_line_type`
   pre-dial scrubbing.
5. **Unbypassable suppression** — `master_persons.is_suppressed` + `assertNotSuppressed` gating
   **reveal AND export AND enrichment**.
6. **DSAR fan-out + golden-anchored erasure** (`deleteFanout`) and retention.
7. **Audit immutability** — append-only triggers on `audit_log` (UPDATE/DELETE blocked).
8. **File-upload hardening** for the upload pipeline — AV scan (`av_scan_status`), content-type/size
   caps, CSV formula-injection neutralisation on **import AND export**, zip/decompression-bomb limits.
9. **Secrets** — KMS-wrapped, masked provider keys, never on the client.
10. **Abuse/scraping limits** on bulk export + reveal (rate/volume caps + the export approval gate).
11. **Threat model of the panel** — a malicious or compromised staff operator, and the layered controls
    that bound the damage they can do.
12. A **mandatory tenant-isolation test for every new write path** (the non-negotiable testing rule).

Each control is mapped to **SOC 2 (Trust Services Criteria)**, **GDPR**, and **India DPDP** in §3 and
§13.

---

## 2. Current Challenges

| # | Challenge | Status today | Why it matters for the console |
|---|---|---|---|
| C1 | The admin app is **thin** (no DB access); all cross-tenant reach already funnels through `apps/api` `/admin/*`. But there is **no `data:*` capability** — only the 16-entry closed enum (`packages/types/src/staffCapability.ts:13`). | Partial | New data-ops endpoints would default to *some other* cap (e.g. `compliance:manage`) and over-grant. We need purpose-built `data:read`/`data:manage`/`data:review`/`data:export`. |
| C2 | The audited cross-tenant wrapper `withPlatformTx` exists and writes `platform_audit_log` in-tx (`packages/db/src/client.ts:121`), but **nothing forces** new data-ops routers to use it instead of `withTenantTx`. | Partial | A careless data-ops endpoint could read with `withTenantTx` and a *client-supplied* workspace — that is a cross-tenant escalation. Must be a lint/review gate. |
| C3 | Suppression (`master_persons.is_suppressed`, `masterGraph.ts:123`) gates reveal via `assertNotSuppressed`, but **bulk export and a staff cross-tenant export do not yet exist** and so are not yet wired to it. | Missing path | Export is the highest-volume PII egress. It MUST call `assertNotSuppressed` per row, server-side, unbypassably. |
| C4 | Audit immutability is enforced on `audit_log` (append-only trigger, `schema/billing.ts:169`) and `platform_audit_log` is owner-written. There is **no panel surfacing** of who-did-what-to-whom across tenants. | Shipped (data) / Missing (surface) | The maker/checker and break-glass story depends on the operator believing the trail is permanent and visible. |
| C5 | Bulk import COPY path is **Dark** behind `BULK_IMPORT_ENABLED` (`packages/config/src/env.ts:174`) and runs on `ownerClient` (RLS-bypass, `client.ts:27`) against an UNLOGGED staging table whose only isolation is an explicit `workspace_id` predicate. | Dark | RLS-bypass code is correct *only* because of that predicate. Enabling it ships an RLS-exempt write path — it needs an isolation test and an object-store AV gate. |
| C6 | File-upload AV column exists (`av_scan_status`, `importJobs.ts:50`) but there is **no prod object store** (only dev `FileStore`, `env.ts:181`) and **no scanner wired**. CSV formula-injection is not neutralised on import or export. | Partial | Untrusted CSV is the #1 ingestion attack surface (macro/formula injection, decompression bombs, content-type spoof). |
| C7 | Verification is **Dark** (`passThroughVerifier` until `REACHER_*`/`TWILIO_*` creds, `env.ts:110/117`); `phone_line_type` exists for TCPA gating but no pre-dial scrub job consumes it yet. | Dark | Dialer/telephony is a regulated egress (TCPA/DNC). The line-type gate must be enforced before any number is dialed or exported as "callable". |
| C8 | Provider keys are masked in `features/provider-configs` (read side) but the KMS-wrapping/at-rest story for the panel write side is unstated. | Partial | A staff operator with `providers:manage` must never see or exfiltrate a raw key. |

See [01-Current-State-Analysis](./01-Current-State-Analysis.md#10-status-summary-the-one-table-to-remember) for the
authoritative status matrix and [03-Gap-Analysis](./03-Gap-Analysis.md) for the gap register tiering.

---

## 3. Enterprise Best Practices (cited)

All citations link to [02-Enterprise-Research](./02-Enterprise-Research.md); dimension numbers below
match the 23-dimension brief.

| Dim | Best practice (02) | Control this doc adopts | SOC 2 / GDPR / DPDP |
|---|---|---|---|
| **11** | Attach **source/workflow provenance to every record**; log match decisions; record match composition (D&B MDP). See [02 §dim-11](./02-Enterprise-Research.md#411-audit-logs). | `field_provenance` jsonb on `contacts`/`accounts` already carries per-field winner-map; every data-ops mutation writes `platform_audit_log` in-tx. | SOC 2 CC7.2/CC7.3 (monitoring); GDPR Art. 30 (records of processing); DPDP §8(5) (accountability). |
| **12** | Golden record is a **derived, recomputable view** over preserved source rows; version the resolution *rules* (Salesforce Data Cloud). See [02 §dim-12](./02-Enterprise-Research.md#412-version-history). | Layer-0 `source_records` + `match_links.cluster_id` preserve raw inputs; erasure is golden-anchored (`deleteFanout`) so a derived view can be re-derived without re-exposing erased PII. | GDPR Art. 17 (erasure) + Art. 5(1)(d) (accuracy); DPDP §12 (correction/erasure). |
| **15** | **Preview-vs-redeem privilege split** as an auth surface; tenant/workspace-scoped, ownership-checked, RLS-enforced. See [02 §dim-15](./02-Enterprise-Research.md#415-rbac). | `data:read` (preview/observe, no PII reveal) is a *distinct* capability from `data:manage`/`data:export` (act/egress). Reveal stays Idempotency-keyed and charged. | SOC 2 CC6.1/CC6.3 (logical access, least privilege); GDPR Art. 32 (security of processing); DPDP §8(4). |
| **16** | **Preview-then-commit** gate; pre-compute worst-case spend (Cognism Enrich preview→redeem). See [02 §dim-16](./02-Enterprise-Research.md#416-approval-workflows). | High-risk data-ops (bulk export, retention enforce, cross-tenant merge) require **maker/checker** ([09](./09-Review-and-Approval-System.md)) + JIT elevation before commit. | SOC 2 CC6.3 (segregation of duties); GDPR Art. 25 (data protection by design). |
| **19** | **Never fail the whole batch**; per-record status array; idempotency keys replay first response; **bill only 200s**. See [02 §dim-19](./02-Enterprise-Research.md#419-error-handling). | Upload pipeline produces a per-row reject artifact; export and enrichment charge only on success; idempotency-key uniqueness is the DB-level guard. | SOC 2 A1.1 (availability/processing integrity); GDPR Art. 5(1)(d). |
| **20/21** | Build **operational tooling over audit/decision logs** (Apollo Duplicate Analyzer); clerical-review console; dup-creation provenance. See [02 §dim-21](./02-Enterprise-Research.md#421-operational-tooling). | The console's audit surface (C4) is *itself* tooling over `platform_audit_log` + `audit_log`. | SOC 2 CC7.2; GDPR Art. 30. |
| **22/23** | **Blocking is the load-bearing decision**; dedupe-before-enrichment; cap response size. See [02 §dim-22](./02-Enterprise-Research.md#422-scalability-strategies). | Abuse/scraping caps on export + reveal (§5.10) and response-size caps protect against a compromised operator scripting a mass exfil. | SOC 2 CC6.1 (rate/volume limits as access control). |

---

## 4. Gaps in Current Implementation

Cross-reference: [01-Current-State-Analysis](./01-Current-State-Analysis.md) (status) +
[03-Gap-Analysis](./03-Gap-Analysis.md) (tiered register).

| Gap | Tier (per canonical tiering) | Control owed |
|---|---|---|
| **G-SEC-1** No `data:*` capabilities; data-ops would over-grant on `compliance:*`. | **MVP / Phase 0** | Add `data:read` (Phase 0), `data:manage`/`data:review` (Phase 1), `data:export` (Phase 2) to `staffCapability` enum + `ROLE_CAPABILITIES`. |
| **G-SEC-2** No enforced rule that data-ops endpoints use `withPlatformTx` not `withTenantTx`. | **MVP / Phase 0** | A review checklist + an isolation test per write path (§11); `withPlatformTx` is the only sanctioned panel write. |
| **G-SEC-3** Bulk export does not exist and is therefore not suppression-gated, approval-gated, or formula-injection-safe. | **Medium / Phase 2** | New `/admin/data/export` behind `data:export` + maker/checker + per-row `assertNotSuppressed` + CSV neutralisation + bounded download window. |
| **G-SEC-4** Dark bulk import runs on RLS-bypass `ownerClient` with no AV scan and no prod object store. | **MVP / Phase 0** | AV-scan gate on `av_scan_status` before staging→promote; prod object-store adapter; isolation test on the COPY path. |
| **G-SEC-5** CSV formula-injection neutralised nowhere (import or export). | **MVP / Phase 0** (import) / **Phase 2** (export) | Sanitiser in `packages/core/src/import/streamParse.ts` (parse side) and in the export serialiser. |
| **G-SEC-6** TCPA/DNC pre-dial scrub job not wired; `phone_line_type` unused. | **Medium / Phase 1** | Verification activation (`TWILIO_*`) + a pre-dial/pre-export gate keyed on `phone_line_type`. |
| **G-SEC-7** Retention engine **Inert shadow** (deletes nothing); enforce rollout needs approvals. | **Enterprise / Phase 3+** | Graduate classes shadow→enforce behind maker/checker + per-class `mode` flip ([retention engine memo]). |
| **G-SEC-8** No panel surface over `platform_audit_log` — the deterrent is invisible. | **MVP / Phase 0** | Read-only audit surface (already `audit:read`); data-ops actions visible cross-tenant. |

---

## 5. Recommended Solution

The control architecture is **five concentric rings** around every data-ops action. An action only
executes when **all five** pass. This is the panel's defence-in-depth contract.

```
                    ┌─────────────────────────────────────────────┐
                    │  Ring 5  IMMUTABLE AUDIT                     │
                    │  platform_audit_log row written IN-TX        │
                    │  (withPlatformTx) + audit_log append-only    │
                    │   ┌───────────────────────────────────────┐ │
                    │   │ Ring 4  MAKER/CHECKER + JIT ELEVATION  │ │
                    │   │ high-risk: export, enforce, merge      │ │
                    │   │  ┌─────────────────────────────────┐   │ │
                    │   │  │ Ring 3  AUDITED CROSS-TENANT TX  │   │ │
                    │   │  │ withPlatformTx (owner conn) —    │   │ │
                    │   │  │ NEVER withTenantTx + body scope  │   │ │
                    │   │  │  ┌───────────────────────────┐   │   │ │
                    │   │  │  │ Ring 2  CAPABILITY GATE    │   │   │ │
                    │   │  │  │ requireCapability(data:*)  │   │   │ │
                    │   │  │  │  ┌─────────────────────┐   │   │   │ │
                    │   │  │  │  │ Ring 1  AUTHN+PA    │   │   │   │ │
                    │   │  │  │  │ authn(Bearer)+claims│   │   │   │ │
                    │   │  │  │  │ .pa===true (signed) │   │   │   │ │
                    │   │  │  │  │ +requireStaffRole   │   │   │   │ │
                    │   │  │  │  │ (live role lookup)  │   │   │   │ │
                    │   │  │  │  └─────────────────────┘   │   │   │ │
                    │   │  │  └───────────────────────────┘   │   │ │
                    │   │  └─────────────────────────────────┘   │ │
                    │   └───────────────────────────────────────┘ │
                    └─────────────────────────────────────────────┘
```

### 5.1 Tenant isolation — three transaction wrappers, one of which is for the panel

TruePoint has exactly three sanctioned data paths (`packages/db/src/client.ts`). The console uses **only
the third**:

1. **`withTenantTx(scope, fn)`** (`client.ts:74`) — the **tenant request flow**. Drops to the
   non-BYPASSRLS role `leadwolf_app` (`SET LOCAL ROLE leadwolf_app`) and sets
   `app.current_tenant_id` / `app.current_workspace_id` **LOCAL** to the transaction (RDS-Proxy /
   PgBouncer transaction-pooling safe). RLS predicates use `workspace_id = NULLIF(current_setting(
   'app.current_workspace_id', true), '')::uuid` — **`NULLIF(..,'')` is the fail-closed hinge**: if the
   GUC is unset or empty, `NULLIF` yields `NULL`, `workspace_id = NULL` is never true, and the query
   returns **zero rows** rather than all rows. Tables carry **`ENABLE` + `FORCE ROW LEVEL SECURITY`**
   (`packages/db/src/rls/*.sql`) so the policy applies **even to the table owner** in that role.
   **The console does NOT use this** — scope here would come from the request, and the request is staff,
   not a tenant.

2. **`withErTx(fn)`** (`client.ts:56`) — **structural Layer-0 isolation**. Role `leadwolf_er` is
   NON-BYPASSRLS and has **no overlay grant**: it can reach only the system-owned master graph
   (`master_*`, `source_records`, `match_links`) and **physically cannot** touch a tenant overlay table.
   The master tables carry no `workspace_id` and are not RLS-scoped — isolation is **structural, by
   access path** (the role's grant set), not by a row predicate. There are no GUCs to set. The Dedup &
   Linking review queue ([07](./07-Deduplication-and-Linking.md)) reads Layer-0 through this role.

3. **`withPlatformTx(actor, action, fn, target)`** (`client.ts:121`) — the **audited cross-tenant
   path**, and the **only** write path for the Data Console. The base connection is the DB owner
   (bypasses RLS), so it can read across every workspace — and therefore it **MUST** be reached only
   behind a verified `pa` (platform-admin) claim, **never from the tenant request flow**. Critically,
   **every call writes a `platform_audit_log` row in the SAME transaction** (`client.ts:128-134`): the
   audit and the privileged action commit or roll back together — there is no "did the action, lost the
   audit" window. `action` and the `target` (`targetType`/`targetId`/`tenantId`/`workspaceId`/
   `metadata`) name *what was acted on* so the immutable trail reads "operator X did Y to tenant Z".

> **The binding rule (Ring 3).** Every Data Console endpoint that reads or writes tenant data uses
> `withPlatformTx`. It is a **review-blocking bug** for a `/admin/data/*` endpoint to call `withTenantTx`
> with a scope taken from the request body or query — that is exactly the cross-tenant escalation RLS
> exists to prevent. (`withTenantTx`'s own contract, `client.ts:118`, says as much: "MUST only be
> reached behind a verified platform-admin (`pa`) claim — never from the tenant request flow.")

### 5.2 Why cross-tenant by design changes the threat math

The customer self-service surface (Surface 2) is bounded by RLS: even a bug there leaks at most one
workspace's data because `leadwolf_app` + the `NULLIF` predicate fail closed. The staff console has
**no RLS boundary** — the owner connection sees everything. The only things standing between an operator
and the entire dataset are the **capability gate, the audit row, the approval gate, and the JIT
window**. That is why those four controls are mandatory and non-skippable for the console, and why the
console is the subject of the explicit threat model in §11.

### 5.3 PII at rest and the reveal model

- **Encryption.** `email_enc` / `phone_enc` are AES-GCM **bytea** (`contacts.ts:103`); plaintext is
  never stored. Lookups go through **HMAC blind indexes** — `email_blind_index` (per-workspace unique
  `uniq_contacts_ws_email`) lets dedup/search match on equality **without decrypting** and without a
  plaintext index an attacker could harvest.
- **Reveal model.** A contact is dark until `is_revealed = true`; `revealed_by_user_id` records who
  spent the credit. The console's `data:read` capability shows **metadata and masked PII only** (e.g.
  `j••••@acme.com`, `+1 415 ••• ••12`). Un-masking in the console is a **distinct, audited action** (it
  is a cross-tenant reveal: `withPlatformTx` action `data.pii.reveal`, capability `data:manage`,
  per-row `assertNotSuppressed`), never a side effect of viewing a list.
- **Decryption locus.** Decryption happens server-side in `apps/api` only, behind the capability gate;
  the admin client (`apps/admin`) receives already-masked strings. Raw `email_enc`/`phone_enc` bytes
  never cross the network seam.

### 5.4 Residency & lawful basis

- **India DPDP.** Cross-tenant access by staff is "processing" under DPDP — it requires a recorded
  purpose. Every `withPlatformTx` `action` + `metadata.reason` (the mandatory justification, mirroring
  `TenantActions.tsx`) is that record (DPDP §8(5) accountability; §8(9) Data Protection Officer
  traceability).
- **GDPR Art. 14 source-notice.** Enriched prospect data is collected indirectly; `field_provenance`
  and Layer-0 `source_records` preserve **which source supplied each field**, enabling the Art. 14
  notice and the Art. 15 "where did you get this" answer.
- **TCPA / DNC.** `phone_line_type` (`contacts.ts`) is the pre-dial / pre-export gate. A number typed
  `mobile` in a DNC-governed region, or any number without a confirmed line type, is **excluded from
  any export marked "callable" and from any dialer hand-off** until scrubbed (G-SEC-6). The console's
  export builder applies this filter server-side; the operator cannot toggle it off.

### 5.5 Unbypassable suppression

`master_persons.is_suppressed` (`masterGraph.ts:123`) mirrors global suppression/objection state and is
set by the DSAR fan-out. `packages/core/src/compliance/assertNotSuppressed.ts` is the single chokepoint
and **must gate all three PII-egress verbs**:

- **Reveal** — already gated (shipped).
- **Enrichment** — `assertNotSuppressed` before any provider call and before writeback (no spend on a
  suppressed person; [08](./08-Data-Enrichment-Workflow.md)).
- **Export** — `assertNotSuppressed` **per row** in the export serialiser, server-side, before the row
  is written to the artifact. A suppressed row is dropped and counted in a `suppressed_omitted` tally,
  never silently included.

Because suppression lives on the **golden** `master_persons` node, a single objection suppresses the
person across **every** tenant overlay that links to them — the control is global and cannot be evaded
by switching workspaces.

### 5.6 DSAR fan-out + golden-anchored erasure

`packages/core/src/compliance/deleteFanout.ts` performs golden-anchored erasure: given a
`master_persons` node, it fans out to every linked overlay `contacts` row (across tenants), writes the
DSAR tombstone (`contacts.deleted_at`), sets `is_suppressed`, and erases the encrypted PII while
**preserving the Layer-0 key-ring** so derived golden records remain recomputable without re-exposing
the erased identity (best practice dim-12/13). Runs through the audited path (`withPrivilegedTx` /
`withPlatformTx`) with a `platform_audit_log` entry. Retention ([retention engine, Inert shadow]) is the
scheduled complement: `data-retention-sweep` runs **shadow** by default (counts, deletes nothing) until
a class graduates to `enforce` behind approval (G-SEC-7, Phase 3+).

### 5.7 Audit immutability

`audit_log` (`schema/billing.ts:169`) is **append-only**: a trigger **blocks UPDATE and DELETE** at the
database, so even a compromised app role cannot rewrite history. Writes go through
`packages/core/src/compliance/writeAudit.ts`. `platform_audit_log` is written **only** by the owner
connection inside `withPlatformTx` (`client.ts:128`) / `recordPlatformEvent` — `leadwolf_app` has no
insert grant, so a tenant request can never forge a platform-audit row. This immutability is the
**deterrent backbone** of the §11 threat model: the operator knows the trail cannot be erased.

### 5.8 File-upload hardening (the upload pipeline)

For [05-Upload-Pipeline-Design](./05-Upload-Pipeline-Design.md), the security gates on ingestion are:

1. **AV scan.** `import_jobs.av_scan_status` (`importJobs.ts:50`, default `pending`) must reach `clean`
   **before** the job can leave `staged` for `running`. The object-store adapter (replacing dev
   `FileStore`) streams the upload to a scanner (ClamAV / cloud AV); `infected` → job `failed`, file
   quarantined, `platform_audit_log` entry.
2. **Content-type + size caps.** Server validates the declared MIME against sniffed magic bytes
   (reject content-type spoofing) and enforces a hard byte cap sized from the response/throughput budget
   (02 dim-2). Oversize → `ValidationError` (422) before a single row is parsed.
3. **CSV formula injection.** On **import**, `packages/core/src/import/streamParse.ts` neutralises any
   cell beginning with `= + - @ TAB CR` by prefixing a single quote / stripping, so a malicious cell
   like `=HYPERLINK(...)` never persists as a live formula. On **export**, the serialiser applies the
   **same** neutralisation — a cell exported to a customer's Excel must not execute. This is required in
   **both** directions; export is the one operators forget.
4. **Decompression bombs.** Reject archives whose declared/!sniffed uncompressed ratio exceeds a cap and
   whose expanded size exceeds the byte cap; stream-decompress with a running byte budget that aborts
   on overrun. No nested-archive expansion.
5. **RLS-bypass staging caveat.** The bulk COPY path uses `ownerClient` (RLS-bypass) against an UNLOGGED
   staging table because Postgres forbids COPY on RLS tables (`client.ts:20-26`). Its **only** isolation
   is the explicit `workspace_id` predicate every staging query carries. Therefore the COPY path
   carries a **mandatory tenant-isolation test** (§11) proving a job for workspace A can never read or
   promote into workspace B, and the AV gate (1) must pass before promote.

### 5.9 Secrets

Provider API keys are **KMS-wrapped at rest**, surfaced **masked** in `features/provider-configs`
(read), and **never** sent to any client. The panel write path (`providers:manage`) accepts a new key,
encrypts it under KMS server-side, and stores only the ciphertext + a masked display tail; the plaintext
exists only transiently in the API process. No secret is ever placed in `platform_audit_log` metadata,
in an export, or in a log line (the audit insert in `withPlatformTx` takes a `metadata` jsonb that
callers must scrub of secrets — see `recordPlatformEvent`'s "Never pass codes/tokens/PII" contract,
`client.ts:144`).

### 5.10 Abuse / scraping limits on bulk export + reveal

A compromised operator's most valuable action is **mass exfiltration**. Controls:

- **Volume caps.** A single export request is capped (row ceiling); exports above the ceiling route to
  the file-async path with a **maker/checker approval** ([09](./09-Review-and-Approval-System.md)) and a
  pre-computed worst-case row/PII count shown to the approver (02 dim-16).
- **Rate windows.** Per-operator multi-window rate limits on `data.export` and `data.pii.reveal`
  (e.g. N reveals / minute, M exports / hour) with `429` + quota-reset headers (02 dim-18/19).
- **Bounded download window.** Export artifacts live in a signed-URL bucket with a short TTL and a
  download-count cap; after expiry the artifact is purged.
- **Suppression + line-type filters** (§5.5, §5.4) run server-side on every export — they are not
  operator-toggleable.

---

## 6. Implementation Steps (sequenced)

1. **Phase 0 — capability + isolation contract.**
   1. Add `data:read` to `staffCapability` (`packages/types/src/staffCapability.ts:13`) and grant it to
      `read_only`-plus roles per [11](./11-Roles-and-Permissions.md); `super_admin` implies it
      automatically.
   2. Mount `/api/v1/admin/data/*` routers (`apps/api/src/features/admin/`) with the standard gate stack:
      `authn` → `platformAdmin` (rejects unless `claims.pa===true`) → `requireStaffRole` (live role,
      immediate revocation) → `requireCapability('data:read')`. Every handler uses `withPlatformTx`.
   3. Land the **tenant-isolation test harness** (§11) and wire it as a CI gate for the data-ops package.
2. **Phase 0 — upload hardening.** AV-scan gate on `av_scan_status`; prod object-store adapter; CSV
   import sanitiser; isolation test on the COPY staging path; flip readiness for `BULK_IMPORT_ENABLED`.
3. **Phase 1 — manage/review caps.** Add `data:manage` + `data:review`; gate the validation/dedup-review/
   enrichment-console writes; wire `assertNotSuppressed` + suppression to enrichment runs; activate the
   email verifier creds.
4. **Phase 1 — TCPA/DNC.** Wire `TWILIO_*`, populate `phone_line_type`, add the pre-export/pre-dial scrub
   gate.
5. **Phase 2 — export + approval.** Add `data:export`; build the audited bulk-export endpoint with
   per-row suppression + line-type filters + CSV-injection-safe serialiser + maker/checker approval +
   bounded download window + volume/rate caps.
6. **Phase 2 — audit surface.** Read-only cross-tenant audit view over `platform_audit_log` + `audit_log`
   (capability `audit:read`).
7. **Phase 3+ — retention enforce.** Graduate retention classes shadow→canary→enforce behind maker/
   checker; version-history/rollback; lineage; SLO alerting.

---

## 7. UI/UX Requirements

The key security-relevant screen is the **Data Console action confirmation** — the moment a staff
operator commits a cross-tenant, audited action. It must make the blast radius and the audit
consequence unmistakable, capture the mandatory justification, and (for high-risk ops) surface the
maker/checker state. It imitates `features/tenants/components/TenantActions.tsx` (Dialog + Tp* inputs +
`useToast` + mandatory reason + JIT-elevation).

### 7.1 ASCII wireframe — cross-tenant export confirmation (high-risk, maker/checker)

```
┌─ Dialog ───────────────────────────────────────────────────────────────────┐
│  Export contacts — CROSS-TENANT  ·  requires approval        [StatusBadge:  │
│                                                               Pending review]│
│  ──────────────────────────────────────────────────────────────────────────│
│  Scope          Tenant: Acme Corp (ten_8f…)  ·  Workspace: Sales (ws_2a…)    │
│  Rows matched   12,480        After suppression filter   12,107  (-373) ⚠    │
│  PII columns    email, phone (line-type-filtered: -52 non-callable)          │
│  Worst-case     12,107 emails · 11,930 phones  → egress logged & audited     │
│  ──────────────────────────────────────────────────────────────────────────│
│  [TpSelect] Format: CSV (formula-injection-neutralised) ▾                    │
│  [TpCheckbox] ☑ I confirm suppression + DNC filters applied (cannot disable) │
│                                                                              │
│  Justification (required, audited) ─ DPDP §8(5) / GDPR Art.30                │
│  [TpTextarea] ____________________________________________________________  │
│                                                                              │
│  This action writes platform_audit_log and needs a second approver.         │
│  [TpButton ghost: Cancel]            [TpButton primary: Request approval →]  │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 7.2 Components (`@leadwolf/ui`)

`Dialog`, `StatusBadge` + `StatusTone` (Pending review / Approved / Denied), `TpSelect`, `TpCheckbox`
(the non-disableable filter confirmation), `TpTextarea` (justification), `TpButton`, `ToastProvider` /
`useToast` (success/failure), `StatTile` (rows / after-suppression / PII counts), `Tooltip` (explains
the suppression delta). The list/queue views reuse `DataTable` + `Column<T>`, `Pagination` (keyset),
`StateSwitch`.

### 7.3 Four states (via `StateSwitch`)

- **Loading** — `LoadingState` / `Skeleton` rows while the match-count + suppression-delta preview is
  computed server-side (the preview is a real query, so it is async).
- **Empty** — `EmptyState` "No rows match this scope" when the filtered count is 0 (e.g. everything is
  suppressed): the export button is disabled.
- **Error** — `ErrorState` rendering `problemMessage(res, fallback)` from the RFC-7807 envelope
  (`ForbiddenError` → "You lack `data:export`"; `ProviderBudgetExceededError`/`429` → "Rate limit, retry
  in N s"; `SuppressedError` surfaced if a per-row gate trips at commit).
- **Data** — the confirmation above; on submit, optimistic `useToast` "Approval requested", then the row
  appears in the approvals queue ([09](./09-Review-and-Approval-System.md)).

---

## 8. Database & Backend Changes

### 8.1 Reused (no change)

- `platform_audit_log` — written in-tx by `withPlatformTx` (`client.ts:128`); the immutable
  cross-tenant trail. **Reused as-is.**
- `audit_log` (`schema/billing.ts:169`) — append-only, UPDATE/DELETE blocked by trigger. **Reused.**
- `master_persons.is_suppressed` (`masterGraph.ts:123`) — suppression source of truth. **Reused.**
- `contacts.email_enc/phone_enc/email_blind_index/is_revealed/revealed_by_user_id/phone_line_type/
  deleted_at` (`contacts.ts:103`) — PII, reveal, TCPA gate, tombstone. **Reused.**
- `import_jobs.av_scan_status` (`importJobs.ts:50`) — AV gate. **Reused.**
- RLS policies (`packages/db/src/rls/*.sql`) — `ENABLE` + `FORCE`, `NULLIF` fail-closed. **Reused.**

### 8.2 New — staff capability rows (code, not migration)

`packages/types/src/staffCapability.ts` enum gains `data:read`, `data:manage`, `data:review`,
`data:export`; `ROLE_CAPABILITIES` grants them per [11](./11-Roles-and-Permissions.md). No DB migration
(capabilities are resolved in code; the active role comes from `platform_staff` via `requireStaffRole`).

### 8.3 New table — export jobs (the next sequential migration, 0035+)

Bulk export needs a server-owned, audited, idempotent job **artifact** ledger so the bounded download
window and the suppression tally are durable and reviewable. **`data_export_jobs` is the export ARTIFACT
table only — it does NOT own the approval decision.** A bulk export goes through the **generic
maker/checker flow** owned by [09](./09-Review-and-Approval-System.md): requesting an export creates a
`data_export_jobs` row **and** an `approval_request` row (09, `operation=bulk_export`). The
`approval_request` row is the **authoritative** approval record; `data_export_jobs.status` is **driven by
that approval** (the `approved_by` column below is a denormalised mirror for convenience, never the source
of truth). **Layer-0/control table — system-owned, NOT RLS-scoped; isolated structurally; only ever
touched via `withPlatformTx`** (the console) — it must never be reachable by `leadwolf_app`.

```sql
-- the next sequential migration (0035+); filename assigned at implementation time, since several
-- docs add migrations in the same phase (see §8.3 migration-number note)
CREATE TABLE data_export_jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- WHO / scope (a reference for audit, NOT an RLS scope):
  requested_by      uuid NOT NULL,                       -- staff actor (maker)
  approved_by       uuid,                                -- denormalised mirror of the checker from
                                                         -- approval_request (09); authoritative record
                                                         -- lives in approval_request, NULL until approved
  tenant_id         uuid NOT NULL,                       -- the target tenant being exported
  workspace_id      uuid NOT NULL,                       -- the target workspace
  -- WHAT:
  entity            varchar(20) NOT NULL,                -- 'contacts' | 'accounts'
  filter_json       jsonb NOT NULL,                      -- the saved-search / filter spec
  columns           text[] NOT NULL,                     -- requested columns (PII columns flagged)
  format            varchar(10) NOT NULL DEFAULT 'csv',
  -- STATE MACHINE (driven by the authoritative approval_request (09); this table mirrors it):
  status            varchar(20) NOT NULL DEFAULT 'pending_approval',
                    -- pending_approval|approved|denied|running|completed|failed|expired|cancelled
  -- COUNTS (the audit/suppression story):
  rows_matched      integer,
  rows_suppressed   integer NOT NULL DEFAULT 0,          -- assertNotSuppressed drops
  rows_dnc_filtered integer NOT NULL DEFAULT 0,          -- phone_line_type / DNC drops
  rows_exported     integer,
  -- ARTIFACT / abuse controls:
  artifact_key      text,                                -- object-store key (signed-URL bucket)
  artifact_expires_at timestamptz,                       -- bounded download window
  download_count    integer NOT NULL DEFAULT 0,
  download_cap      integer NOT NULL DEFAULT 3,
  -- IDEMPOTENCY + provenance:
  idempotency_key   text NOT NULL,
  justification     text NOT NULL,                       -- DPDP §8(5) / GDPR Art.30 reason
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uniq_data_export_idem UNIQUE (idempotency_key)
);
CREATE INDEX idx_data_export_status ON data_export_jobs (status, created_at DESC);

-- RLS posture: this is a system/control table. Do NOT enable a workspace RLS policy on it
-- (it has no leadwolf_app grant). Isolation is STRUCTURAL: only the owner connection inside
-- withPlatformTx (verified pa claim) reads/writes it. Mirrors import_jobs' control-table posture.
REVOKE ALL ON data_export_jobs FROM leadwolf_app;
```

- **RLS posture:** not RLS-scoped; structurally isolated (no `leadwolf_app` grant), reached only via
  `withPlatformTx`. **Tx wrapper:** `withPlatformTx` for every create/transition/read (each writes a
  `platform_audit_log` row in the same tx). The append-only `audit_log` records the customer-facing
  compliance event (`data.export.completed`) via `writeAudit`.
- **Migration number:** the **next sequential migration (0035+)** — the concrete 4-digit slug is assigned
  at implementation time, since several docs add migrations in the same phase and they are numbered
  sequentially (0035, 0036, 0037, …) when landed; register in `meta/_journal.json`; `drizzle.config.ts`
  strict mode regenerates types.

---

## 9. API Requirements

All endpoints mount under `apps/api/src/features/admin/` at `/api/v1/admin/data/*`, behind the gate
stack `authn` → `platformAdmin` (`claims.pa===true`) → `requireStaffRole` → `requireCapability(...)`,
and execute inside `withPlatformTx`. Shared Zod from `@leadwolf/types`, `safeParse` at the edge,
`parse` on response. Keyset pagination (`packages/types/src/search.ts`, `limit 1..200 default 50`,
`nextCursor string|null`). RFC 9457 problem envelope.

### 9.1 `POST /api/v1/admin/data/export/preview`

Compute match count + suppression/DNC deltas without producing an artifact (no spend, no egress).

- **Gate:** `requireCapability('data:export')` (preview is privileged: it reveals counts).
- **Request (Zod):** `{ tenantId: uuid, workspaceId: uuid, entity: 'contacts'|'accounts',
  filter: SearchFilter, columns: string[] }`
- **Response:** `{ rowsMatched: number, rowsAfterSuppression: number, rowsSuppressed: number,
  rowsDncFiltered: number, piiColumns: string[] }` (re-validated with `parse`).
- **Errors:** `ValidationError` 422; `ForbiddenError` 403 (missing cap / `pa` false);
  `NotFoundError` (unknown tenant/workspace).
- **Idempotency:** none (read-only). **Pagination:** none.

### 9.2 `POST /api/v1/admin/data/export`

Create an export job (enters `pending_approval`; for sub-ceiling exports may auto-approve per policy).

- **Gate:** `requireCapability('data:export')`. **Idempotency:** `Idempotency-Key` header required
  (egress = money/PII); DB unique `uniq_data_export_idem` is the real guard — replay returns the first
  response.
- **Request:** preview shape **plus** `{ justification: string (min 10), format: 'csv' }`.
- **Response:** `{ jobId: uuid, status: 'pending_approval'|'approved', rowsMatched, rowsSuppressed,
  rowsDncFiltered }`.
- **Errors:** `ValidationError` 422 (missing justification); `ForbiddenError` 403; `SuppressedError`
  (if the entire scope is suppressed → 0 exportable); `429` (rate/volume cap) →
  `ProviderBudgetExceededError`-style envelope.
- **Effect:** in one `withPlatformTx(actor,'data.export.requested', …, {tenantId, workspaceId,
  metadata:{rowsMatched, justification}})` — audit row in-tx — creates the `data_export_jobs` artifact row
  **and** the sibling `approval_request` row ([09](./09-Review-and-Approval-System.md),
  `operation=bulk_export`) that owns the maker/checker decision. The job's `status` then follows that
  approval (approve via §9.3).

### 9.3 Approval — via the generic maker/checker flow ([09](./09-Review-and-Approval-System.md))

Export approval is **not** an export-specific mechanism. There is **no** `/admin/data/export/:jobId/approve`
endpoint. The `data_export_jobs` row created in §9.2 has a sibling `approval_request` row
(`operation=bulk_export`) owned by [09](./09-Review-and-Approval-System.md), and the approver acts through
**09's** generic endpoint:

- **Endpoint:** `POST /api/v1/admin/data/approvals/:id/approve` (09; the matching reject endpoint is 09's
  as well).
- **Gate:** `requireCapability('data:review')` **and** a server-side `approver !== requested_by` check
  (segregation of duties — the checker cannot be the maker). Requesting the export needs `data:export`
  (§9.2); **approving it needs `data:review`.** Optionally requires an active JIT elevation.
- **Effect:** on approve, `approval_request` becomes authoritative and **drives** `data_export_jobs.status`
  → `approved`, which enqueues the export worker (the worker runs the per-row `assertNotSuppressed` +
  `phone_line_type` filters + CSV neutralisation, writes the artifact to the signed-URL bucket with
  `artifact_expires_at`). The 09 approve handler runs inside `withPlatformTx` and writes the
  `platform_audit_log` row.
- **Errors:** `ForbiddenError` 403 (`approver === requested_by` → "maker cannot approve own request", or
  missing `data:review`); `NotFoundError`; `ValidationError`.

### 9.4 `GET /api/v1/admin/data/export/:jobId/download`

- **Gate:** `requireCapability('data:export')`; checks `status='completed'`, `now() <
  artifact_expires_at`, `download_count < download_cap`.
- **Response:** `302` to a short-TTL signed URL; increments `download_count`.
- **Errors:** `NotFoundError` (expired/purged → 404, never a stale URL); `ForbiddenError` 403.
- **Effect:** `withPlatformTx(actor,'data.export.downloaded', …)`.

### 9.5 `POST /api/v1/admin/data/pii/reveal`

Cross-tenant un-mask of a single field (distinct from list view).

- **Gate:** `requireCapability('data:manage')`. **Idempotency:** `Idempotency-Key` required.
- **Request:** `{ tenantId, workspaceId, contactId: uuid, field: 'email'|'phone' }`.
- **Response:** `{ value: string }` (decrypted server-side).
- **Errors:** `SuppressedError` (per-row `assertNotSuppressed` fails); `ForbiddenError`; `NotFoundError`.
- **Effect:** `withPlatformTx(actor,'data.pii.reveal', …, {targetId: contactId, tenantId, workspaceId})`
  + rate-limited per operator.

### 9.6 `GET /api/v1/admin/data/audit`

Read-only cross-tenant view over `platform_audit_log` + `audit_log` (the operator-deterrent surface).

- **Gate:** `requireCapability('audit:read')`. **Pagination:** keyset. **Filters:** actor, action,
  tenant, date range. **Response:** `{ rows: AuditRow[], nextCursor: string|null }`. CSV export reuses
  the existing `/admin/audit-log/export`.

---

## 10. Edge Cases & Failure Scenarios

| # | Scenario | Required behaviour |
|---|---|---|
| E1 | Operator calls a `/admin/data/*` write but their role was **just revoked**. | `requireStaffRole` resolves the **live** role per request from `platform_staff` — revocation is immediate, no stale-JWT window. Request → 403. |
| E2 | A data-ops endpoint is (mis)written to use `withTenantTx` with a body-supplied `workspaceId`. | **Review-blocking bug.** Caught by the isolation test (§11) and the §5.1 binding rule. Fail the build. |
| E3 | Export approver is the same person as the requester. | 403 `ForbiddenError` "maker cannot approve own request" (§9.3 segregation of duties). |
| E4 | Suppression flips to `true` **after** preview but **before** the worker runs. | Per-row `assertNotSuppressed` runs **at export time**, not preview time — the row is dropped, `rows_suppressed` increments, artifact reflects the live state. Preview counts are advisory. |
| E5 | Upload's `av_scan_status` is `infected`. | Job → `failed`, file quarantined, `platform_audit_log` entry; never promoted from staging. |
| E6 | CSV cell `=cmd|'/c calc'!A1`. | Neutralised on import (persisted as text) **and** on export (prefixed/quoted). Both directions (§5.8.3). |
| E7 | A 50 KB zip expanding to 8 GB. | Decompression-ratio + expanded-byte budget abort the stream → `ValidationError` 422 (§5.8.4). |
| E8 | Bulk COPY job for workspace A attempts to read/promote workspace B rows. | The staging predicate `workspace_id = $A` plus the **mandatory isolation test** prove zero cross-leak; `ownerClient` use is justified only by that predicate (§5.8.5). |
| E9 | Idempotency-Key replay on `/data/export` after a transient 500. | DB unique `uniq_data_export_idem` returns the **first** response (incl. its job state) — no duplicate egress, no double-audit. |
| E10 | Signed download URL requested after `artifact_expires_at`. | 404 `NotFoundError`; artifact already purged; no stale URL ever served (§5.10). |
| E11 | Operator pastes a raw provider key into the justification field. | Justification/metadata is scrubbed; secrets never enter `platform_audit_log` (§5.9). Validation rejects key-shaped strings best-effort. |
| E12 | DSAR erasure runs while an export of the same person is queued. | Suppression set by the fan-out is read **at export time** → the person is dropped; erasure wins (Security precedence). |
| E13 | Phone with unknown `phone_line_type` exported as "callable". | Excluded; `rows_dnc_filtered` increments. No number leaves without a confirmed line type (§5.4). |

---

## 11. Testing Strategy

**The non-negotiable rule: every new write path gets a tenant-isolation test.** A multi-tenant write
without one is a bug, not a style choice.

### 11.1 Unit

- `assertNotSuppressed` drops a suppressed `master_persons` node on reveal, enrich, **and** export
  paths.
- CSV neutraliser: table-driven cases for `= + - @ \t \r` leading cells, on import parse and export
  serialise.
- Decompression budget: a crafted bomb aborts at the byte ceiling.
- `withPlatformTx` writes exactly one `platform_audit_log` row per call and rolls it back with the
  action on error (action + audit are atomic).
- Maker/checker: `approver === requested_by` rejected.

### 11.2 Integration (apps/api, real DB)

- Gate stack: `authn` → `platformAdmin` (no `pa` → 403) → `requireStaffRole` (revoked → 403) →
  `requireCapability('data:export')` (missing cap → 403).
- Idempotency: duplicate `Idempotency-Key` on `/data/export` returns the first job, single audit row.
- Rate/volume caps: N+1th reveal in the window → 429 with reset header.

### 11.3 itest — mandatory tenant-isolation tests (one per write path)

For **each** of: `/data/export`, `/data/pii/reveal`, the export worker, and the bulk-COPY staging
promote:

1. Seed tenant A (workspace A) and tenant B (workspace B) with distinct PII.
2. Drive the write path scoped to A.
3. Assert **no** row, artifact, audit target, or count from B is read, written, or leaked.
4. Assert the `platform_audit_log` row names A's `tenantId`/`workspaceId` and the acting operator.
5. For the COPY path specifically: assert a job whose `workspace_id = A` cannot SELECT or promote a
   staged row carrying `workspace_id = B` (the predicate-only isolation must hold).

Additionally, an itest asserts `audit_log` UPDATE and DELETE both **raise** (the append-only trigger
holds) and that `leadwolf_app` cannot INSERT into `platform_audit_log`.

> **Note (sandbox).** Per the working-environment constraints, `bun test` / itests run in the user's CI
> step; this doc specifies the tests, the CI run is the decisive gate.

---

## 12. Rollout & Migration Plan

| Stage | Gate state | What ships |
|---|---|---|
| **Phase 0 (Observe)** | `data:read` added; data-ops endpoints behind it; **no new writes**. AV gate + CSV import sanitiser land. Bulk import stays Dark (`BULK_IMPORT_ENABLED=false`). | Read-only Data-Ops Overview + import drill-down + the isolation-test CI gate. |
| **Phase 1 (Validate/Review/Enrich)** | `data:manage` + `data:review` added; suppression wired to enrichment; verifier creds activated; TCPA line-type scrub wired. | Validation/dedup-review/enrichment console writes. |
| **Phase 2 (Approve/Export/Self-Serve)** | `data:export` (request) + `data:review` (approve) added; the next sequential migration (**0035+**, `data_export_jobs`) applied; generic maker/checker ([09](./09-Review-and-Approval-System.md), `operation=bulk_export`) live; export caps + bounded-download live. **Shadow→canary→GA:** export first canary'd to a single internal tenant with `download_cap=1`, then GA. | Audited bulk export + approval; Surface 2 self-service. |
| **Phase 3+ (Govern/Scale)** | Retention classes graduate shadow→enforce behind maker/checker, **one class at a time**; version-history/rollback; SLO alerting. | Retention enforce; lineage. |

**Backfill:** none required for capabilities (resolved in code). `data_export_jobs` starts empty. The
retention enforce graduation is the only state change touching customer data, and it is per-class,
shadow-first, approval-gated — it deletes nothing until a class's `mode` flips to `enforce`.

**Flag gating:** bulk import stays behind `BULK_IMPORT_ENABLED` (`env.ts:174`) + per-tenant
`bulk_import_enabled` until the COPY spike + prod object store + isolation test pass. Verification stays
behind `REACHER_*`/`TWILIO_*` creds. Retention stays behind `retention_engine_enabled` + per-class
`mode`.

---

## 13. Success Metrics & Acceptance Criteria

**Compliance mapping (summary):** SOC 2 CC6.1/CC6.3 (least privilege, segregation of duties),
CC7.2/CC7.3 (monitoring/audit), A1 (processing integrity); GDPR Art. 14/15 (source/access), Art. 17
(erasure), Art. 25 (by design), Art. 30 (records), Art. 32 (security); DPDP §8(4)/(5)/(9) (security,
accountability, DPO traceability), §12 (correction/erasure).

**Acceptance criteria (testable checklist):**

- [ ] **AC-1** Every `/api/v1/admin/data/*` endpoint executes inside `withPlatformTx`; a CI grep/lint
      asserts no `/admin/data/*` handler imports `withTenantTx`.
- [ ] **AC-2** Each new write path (`/data/export`, `/data/pii/reveal`, export worker, COPY promote) has
      a passing tenant-isolation itest proving zero cross-tenant leak (§11.3).
- [ ] **AC-3** `data:read`/`data:manage`/`data:review`/`data:export` exist in `staffCapability` and the
      gate stack returns 403 when any is missing; `super_admin` implies all.
- [ ] **AC-4** Revoking a staff role denies the next request (no stale-JWT window) — itest passes.
- [ ] **AC-5** `assertNotSuppressed` is invoked on reveal **and** enrichment **and** export; a suppressed
      person never appears in an export artifact (`rows_suppressed` accounts for the delta).
- [ ] **AC-6** CSV formula-injection neutralised on import and export (table-driven test green).
- [ ] **AC-7** An upload with `av_scan_status != clean` cannot transition to `running`.
- [ ] **AC-8** Decompression-bomb and oversize uploads are rejected before row parsing.
- [ ] **AC-9** `data_export_jobs` is unreachable by `leadwolf_app` (REVOKE verified); export approval
      rejects `approver === requested_by`.
- [ ] **AC-10** Every data-ops action writes a `platform_audit_log` row in-tx naming actor + target;
      `audit_log` UPDATE/DELETE both raise (append-only trigger verified).
- [ ] **AC-11** Export volume/rate caps return 429 with reset headers; download URLs expire and 404
      after `artifact_expires_at`.
- [ ] **AC-12** No secret (provider key) appears in any audit row, export artifact, or log line.
- [ ] **AC-13** `phone_line_type` filter excludes non-callable/unknown numbers from "callable" exports
      and dialer hand-off (`rows_dnc_filtered` accounts for the delta).
- [ ] **AC-14** DSAR `deleteFanout` erases linked overlay PII across tenants, sets `is_suppressed`, and
      preserves the Layer-0 key-ring for recomputable golden records; audited.

---

### Cross-references

[01-Current-State-Analysis](./01-Current-State-Analysis.md) ·
[02-Enterprise-Research](./02-Enterprise-Research.md) ·
[03-Gap-Analysis](./03-Gap-Analysis.md) ·
[04-Control-Panel-Architecture](./04-Control-Panel-Architecture.md) ·
[05-Upload-Pipeline-Design](./05-Upload-Pipeline-Design.md) ·
[09-Review-and-Approval-System](./09-Review-and-Approval-System.md) ·
[11-Roles-and-Permissions](./11-Roles-and-Permissions.md) ·
[13-Performance-and-Scaling](./13-Performance-and-Scaling.md) ·
[14-Implementation-Roadmap](./14-Implementation-Roadmap.md) · [README](./README.md)
