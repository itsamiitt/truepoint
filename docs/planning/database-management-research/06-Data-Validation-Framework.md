# 06 — Data-Validation Framework

> **Series:** [Database Management](./README.md) · **Type:** Design · **Status:** ✅ Authored · **Prev:**
> [`05-Upload-Pipeline-Design`](./05-Upload-Pipeline-Design.md) · **Next:**
> [`07-Deduplication-and-Linking`](./07-Deduplication-and-Linking.md)

---

## 1. Objective

Design an **operator-authorable validation rules engine** — the single largest true gap in TruePoint's
data platform. Today validation is **implicit and scattered**: Zod parsing at the API edge,
`prepareContact` normalization inside the import worker, ad-hoc `import_job_rows.reject_reason` strings,
and the multi-valued `email_status` enum set by the verifier. There is **no declarative, versioned,
inspectable rule layer** an operator (or a customer) can author, no **pre-commit validation report**, no
**reject-triage queue**, and no first-class tie between validation outcomes and the
[quality-score](#7-uiux-requirements) machinery.

This document specifies:

1. A **persisted rule model** — `validation_rule_sets` + `validation_rules` (workspace/tenant-scoped, RLS),
   plus a global `validation_rule_set_templates` library staff can publish.
2. The **ordered validation stages** — `file → schema → row-level → aggregation` — and exactly where each
   runs (02 dim 4).
3. **Where rules execute**: in the import pipeline *before persist* (the validation-preview step of
   [`05-Upload-Pipeline-Design`](./05-Upload-Pipeline-Design.md#7-uiux-requirements)) **and** on-demand over
   already-persisted data (a "validate existing data" sweep).
4. A **pre-commit validation report** — counts by severity, sample failures, accept/reject decision surface.
5. A **reject-triage queue** built over `import_job_rows` reject reasons.
6. The **quality-score tie-in** — per-dimension sub-scores `accuracy / completeness / consistency /
   timeliness / validity / uniqueness` (02 dim 10) computed from rule outcomes.
7. The **email-status multi-valued rule** — `catch_all` and `unknown` are *distinct risk tiers*, never
   auto-promoted to `valid` (02 dim 4).

This serves **both surfaces** ([`04-Control-Panel-Architecture`](./04-Control-Panel-Architecture.md)): the
**staff console** authors global templates and runs cross-tenant validation sweeps; the **customer
self-service** panel authors workspace-scoped rule sets and sees its own validation reports.

**Status legend:** Shipped / Dark / Inert / Partial / Planned / Missing. This framework is **Missing** today
and targets **Phase 1 (Validate, Dedup-Review, Enrich)** of the canonical tiering in
[`14-Implementation-Roadmap`](./14-Implementation-Roadmap.md).

---

## 2. Current Challenges

| # | Challenge | Where it lives today | Status |
|---|---|---|---|
| C1 | Validation is **implicit**, not declarative — Zod schemas, `prepareContact`, and the verifier each enforce a slice; nothing is operator-visible or operator-editable. | `packages/core/src/import/prepareContact.ts`, `@leadwolf/types` edge schemas | Partial |
| C2 | **Reject reasons are free-text strings** (`import_job_rows.reject_reason text`) — not codified, not queryable by category, not triageable. | `packages/db/src/schema/importJobs.ts:140` | Partial |
| C3 | **No pre-commit report** — customers cannot see "how clean is this file" before committing; the bulk COPY path stages then promotes with no human gate. | [`05`](./05-Upload-Pipeline-Design.md) | Missing |
| C4 | **No reject-triage queue** — once a row rejects, the only artifact is the `rejected_artifact_key` CSV download; no UI to inspect, re-map, correct, and re-submit. | `import_jobs.rejected_artifact_key` | Missing |
| C5 | **Quality scoring is correctness-only and customer-only** — `dataQualityScore` measures freshness/completeness/verification but is **not driven by rule outcomes** and has **no fleet/staff view**. | `packages/core/src/data-health/dataQualityScore.ts` (re-exports `@leadwolf/types` math) | Partial |
| C6 | **`email_status` can be silently mishandled** — `catch_all` and `unknown` are real enum members but no rule guarantees they are never promoted to `valid`; an over-eager mapping or import could treat `unknown` as deliverable. | `contacts.email_status` enum (`unverified\|valid\|risky\|invalid\|catch_all\|unknown`) | Partial |
| C7 | **No rule versioning** — there is nowhere to record *which rule version* rejected a row, so re-running over historical data or auditing a decision is impossible. | n/a | Missing |
| C8 | **No cross-field / referential / uniqueness rules** beyond DB constraints (`uniq_contacts_ws_email`) — these surface as opaque 23505 errors deep in the write path, not as a friendly validation result. | DB constraints only | Partial |
| C9 | **CSV formula-injection** (`=`, `+`, `-`, `@`, tab/CR leading a cell) is unflagged at ingest — a latent exfil/abuse vector on export. | n/a (export hardening deferred to [`12`](./12-Security-and-Compliance.md)) | Missing |

See [`01-Current-State-Analysis` §5.2](./01-Current-State-Analysis.md#52-data-validation--missing-as-a-framework)
and [`03-Gap-Analysis`](./03-Gap-Analysis.md) for the canonical gap register entries (this doc owns
**G-VAL-\*** rows there).

---

## 3. Enterprise Best Practices (cited)

Drawn from [`02-Enterprise-Research`](./02-Enterprise-Research.md), primarily **dim 4 (Data validation)**,
**dim 10 (Quality scoring)**, **dim 11 (Audit/provenance)**, **dim 19 (Error handling)**, and **dim 20
(Monitoring)**.

1. **Ordered validation stages** ([`02` dim 4](./02-Enterprise-Research.md#44-data-validation)). Validate
   in a fixed pipeline: **file** (encoding, size, MIME, AV) → **schema** (header present, required columns
   mapped, no unknown-required gaps) → **row-level** (required / type / format / range / uniqueness /
   referential / business / cross-field) → **aggregation** (whole-file thresholds: "reject the file if >X%
   of rows fail"). Earlier stages **fail fast** so a malformed file never reaches per-row cost.
2. **Email status is multi-valued** ([`02` dim 4](./02-Enterprise-Research.md#44-data-validation)).
   `catch_all` and `unknown` are **distinct risk tiers**, not synonyms for invalid and **never
   auto-promoted** to `valid`. A validation rule must encode each tier's allowed downstream uses.
3. **Quality scoring = numeric, per-dimension, recomputed on change**
   ([`02` dim 10](./02-Enterprise-Research.md#410-quality-scoring)). Score from a few high-signal
   features; expose **per-dimension sub-scores** (accuracy / completeness / consistency / timeliness /
   validity / uniqueness); **pre-filter** bad records so the range floors above zero; **recompute on every
   change**. Confidence is numeric, never boolean.
4. **Provenance on every record** ([`02` dim 11](./02-Enterprise-Research.md#411-audit-logs)). Attach the
   source/workflow that produced or rejected a value so root-cause tooling is possible. TruePoint already has
   `field_provenance` (jsonb winner-map) on `contacts`/`accounts`; validation outcomes extend it.
5. **Never fail the whole batch; emit a per-record status + a failed-results artifact**
   ([`02` dim 19](./02-Enterprise-Research.md#419-error-handling)). Partial-accept vs whole-file-reject is
   a *policy choice keyed on sensitivity* — encode it as an aggregation rule, not a hard-coded constant.
6. **Mapping & validation are visible UI steps before persist**
   ([`02` dim 3](./02-Enterprise-Research.md#43-import-pipelines), brandur idempotency). The validation
   report is a human gate between *staged* and *running*.
7. **Monitor per-dimension quality + reject-cause provenance**
   ([`02` dim 20](./02-Enterprise-Research.md#420-monitoring-dashboards)). The reject-triage queue and the
   quality dashboard ([`10`](./10-Monitoring-and-Observability.md)) read the same rule-outcome ledger.

---

## 4. Gaps in Current Implementation

Cross-reference: [`01-Current-State-Analysis` §5.2 / §5.7](./01-Current-State-Analysis.md#52-data-validation--missing-as-a-framework)
and the gap register in [`03-Gap-Analysis`](./03-Gap-Analysis.md).

| Gap ID | Description | Best-practice violated | Tier |
|---|---|---|---|
| **G-VAL-1** | No declarative rule model — validation cannot be authored, versioned, or inspected. | dim 4, dim 11 | **Phase 1** |
| **G-VAL-2** | No pre-commit validation report; no human gate between stage and promote. | dim 3, dim 6 | **Phase 1** |
| **G-VAL-3** | Reject reasons are free-text; no codified categories, no triage queue. | dim 19, dim 20 | **Phase 1** |
| **G-VAL-4** | Quality sub-scores are not rule-driven and have no staff/fleet view. | dim 10, dim 20 | **Phase 1 → 2** |
| **G-VAL-5** | `catch_all`/`unknown` email tiers not protected by an explicit non-promotion rule. | dim 4 | **Phase 1** |
| **G-VAL-6** | No on-demand "validate existing data" sweep (rules only ever ran implicitly at import). | dim 4, dim 10 | **Phase 1 → 2** |
| **G-VAL-7** | No rule versioning / decision audit (which rule@version rejected which row). | dim 11, dim 12 | **Phase 1** |
| **G-VAL-8** | CSV formula-injection unflagged at ingest. | dim 4 (flag); enforcement → [`12`](./12-Security-and-Compliance.md) | **Phase 1 (flag) / Phase 2 (enforce)** |

---

## 5. Recommended Solution

### 5.1 The rule model

A **rule set** is an ordered, versioned collection of **rules**. A rule set is *bound* to an entity
(`contact` or `account`) and a *trigger surface* (`import`, `on_demand`, or `write_path`). Rules carry a
**stage**, a **severity**, an **operator-readable expression**, and an **action**.

```
validation_rule_sets (1) ──< (N) validation_rules
        │                              │
        │ is_active, version           │ stage, severity, expr, action, version
        ▼                              ▼
   bound to entity + surface     evaluated in stage order, short-circuit on `block`
```

**Stages** (evaluated strictly in this order — 02 dim 4):

| Order | Stage | Examples | Operates on |
|---|---|---|---|
| 1 | `file` | encoding=UTF-8, size ≤ cap, MIME=csv/xlsx, AV clean, ≤N columns | the upload |
| 2 | `schema` | required header present, all required canonical fields mapped, no duplicate mapping, formula-injection flag on headers | the column mapping |
| 3 | `row.required` | `email` OR `linkedin_public_id` present; `account.domain` present | one row |
| 3 | `row.type` | `employee_count` is integer; `started_on` is date | one row |
| 3 | `row.format` | email RFC + MX-plausible shape; phone E.164; domain is a hostname; URL is https | one row |
| 3 | `row.range` | `priority_score` ∈ [0,100]; `employee_count` ≥ 0; `started_on` ≤ today | one row |
| 3 | `row.uniqueness` | `email_blind_index` unique within workspace (mirrors `uniq_contacts_ws_email`) | row vs workspace |
| 3 | `row.referential` | `account_id` / `target_list_id` resolves to a live row in this workspace | row vs workspace |
| 3 | `row.business` | `email_status='unknown'` ⇒ may stage but not mark deliverable; TCPA: `phone_line_type='mobile'` requires consent flag | one row (domain logic) |
| 3 | `row.crossfield` | if `is_current=true` then `ended_on` must be null; if `email` present then `email_domain` must equal its host | one row (multi-column) |
| 4 | `aggregation` | reject the whole file if `rejected/total > threshold`; warn if `> warn_threshold`; require `≥1` mapped contact key | the batch |

**Severities** (govern the action and the report):

| Severity | Meaning | Default action |
|---|---|---|
| `block` | Row/file cannot be persisted as-is. | `reject` the row (or whole file at aggregation stage). |
| `warn` | Suspicious but persistable; surfaced and counted. | `flag` (persist, annotate, count). |
| `info` | Observational; feeds quality sub-scores only. | `score_only`. |

**Actions:** `reject` (row → `import_job_rows.outcome='rejected'`), `flag` (persist + annotate
`field_provenance` + count), `score_only` (no row effect; contributes to a quality sub-score),
`normalize` (a *transform* rule — e.g. lowercase email, strip phone punctuation — applied in
`row.format`/`row.type` before evaluation; this is where today's `prepareContact` logic becomes
declarative).

### 5.2 Rule expression language

Rules are **not arbitrary code** (a code-injection and tenant-isolation hazard — Security has final say).
Each rule is a **declarative descriptor** `{ field, op, args }` drawn from a **closed operator registry**
implemented in `packages/core/src/data-health/validation/operators.ts`. Operators:

```
present | absent | type(int|number|date|bool|string) | matches(regex_id) | inSet(values)
| range(min,max) | maxLen(n) | minLen(n) | unique(scope) | references(entity)
| equals(field) | dependsOn(field, whenOp) | oneOf(fields) | emailTier(allowed[])
| domainMatchesEmail | notFuture | formulaInjectionFree
```

- `matches(regex_id)` references **named, pre-vetted patterns** (no operator-supplied regex → no ReDoS, no
  injection). The pattern library ships in code; staff can request additions via a separate change.
- `unique(scope)` and `references(entity)` are evaluated against the **same `withTenantTx` connection** the
  import runs in — so they are RLS-scoped and cannot peek across workspaces.
- `emailTier(allowed[])` encodes the **multi-valued email rule** (02 dim 4): the default contact rule set
  ships `emailTier(['valid'])` for "deliverable" gating with `catch_all` and `unknown` **explicitly
  excluded**, and a separate `warn`-severity rule `emailTier(['valid','catch_all'])` that flags rather than
  blocks. **No operator can author a rule that promotes `unknown`/`catch_all` to `valid`** — promotion is
  *only* performed by the verifier (`packages/core/src/data-health/emailVerifier.ts`), never by a validation
  rule. This is enforced structurally: validation rules have no write access to `email_status` (action
  `flag` writes provenance/annotations, not the status enum).

### 5.3 Where rules run

**(a) Import pipeline — before persist** (the validation-preview step of
[`05` §validation-preview](./05-Upload-Pipeline-Design.md#7-uiux-requirements)). The import job transitions
`queued → validating`; the validation engine streams the staged rows (the UNLOGGED staging table for the
bulk COPY path, or the parsed stream for the standard path), evaluates stages 1–3 per row and stage 4 over
the tallies, writes a **validation report** (§5.4), and **parks the job at `staged`** awaiting an
accept/reject decision. Only on **accept** does it transition `staged → running` and drain into `contacts`.
Rejected rows never reach `contacts`; they land in `import_job_rows` with `outcome='rejected'` and a
**codified** reject reason (§5.5).

**(b) On-demand over existing data** — a "validate existing data" sweep
([`10`](./10-Monitoring-and-Observability.md)). An operator (staff or customer) selects a rule set and a
scope (a list, a saved search, or the whole workspace); a queued job re-evaluates rules over persisted
`contacts`/`accounts` inside `withTenantTx`, writing outcomes to a **validation_run** ledger (not mutating
the records; `flag`/`score_only` only). This drives the quality dashboard and surfaces drift as rules
evolve. Reuses the queue infra in `apps/workers` (a new `validation-sweep` queue with `.dlq` partner).

**(c) Write path (Phase 2, optional)** — the highest-severity `block` rules can also run synchronously in
`PATCH /contacts/:id` to reject obviously bad single-record edits. Deferred; the import + sweep paths cover
the gap.

### 5.4 The pre-commit validation report

A `validation_runs` row (one per import validation pass or sweep) holds the **rollup**; `validation_results`
holds **sample failures** (capped — see [edge cases](#10-edge-cases--failure-scenarios) for huge reject
sets). The report API returns:

```jsonc
{
  "runId": "uuid",
  "ruleSetId": "uuid", "ruleSetVersion": 7,
  "rowsTotal": 48211,
  "bySeverity": { "block": 1204, "warn": 3380, "info": 9120 },
  "byStage":    { "schema": 2, "row.format": 902, "row.uniqueness": 300, "row.business": 0, "aggregation": 0 },
  "byRule": [ { "ruleId": "uuid", "code": "email.format", "severity": "block", "count": 902, "samples": [ … ] } ],
  "aggregationVerdict": "pass",          // pass | reject_file | warn
  "rejectRatio": 0.0249,
  "samplesCapped": true,
  "decision": "pending"                  // pending | accepted | rejected (by an operator)
}
```

### 5.5 Codified reject reasons & the triage queue

`import_job_rows.reject_reason` stays (back-compat) but is **paired** with structured columns so triage can
group, filter, and re-submit. The triage queue is a `DataTable` over rejected rows grouped by reject **code**
(the rule `code`), with per-group bulk actions: **download**, **re-map & re-validate** (fix the column
mapping and re-run just the rejects), **correct & re-submit** (edit sampled values), **dismiss** (accept the
rejection). Re-submission creates a *child* import job whose `idempotency_key` derives from the parent +
reject-set hash so a double-click cannot double-import.

### 5.6 Quality-score tie-in

Rule outcomes feed the **per-dimension sub-scores** (02 dim 10). The existing math
(`packages/core/src/data-health/dataQualityScore.ts`, which re-exports `@leadwolf/types` `dataHealth.ts`)
already produces `freshness`, `verification`, and `completeness` sub-scores. We **extend** the
`QualitySubScores` shape with the remaining 02 dim-10 dimensions, each derived from validation results:

| Sub-score | Source signal |
|---|---|
| `accuracy` | share of `row.format`/`row.type`/`row.range` rules passing |
| `completeness` | (existing) `COMPLETENESS_WEIGHTS` over required/important fields |
| `consistency` | share of `row.crossfield` rules passing (e.g. email-domain agreement, current-employment integrity) |
| `timeliness` | (existing) `freshnessSubScore` from `last_verified_at` vs `FRESHNESS_SLA_DAYS` |
| `validity` | share of `schema`+`row.business` rules passing, incl. email-tier gating |
| `uniqueness` | share of `row.uniqueness` rules passing (1 − duplicate rate within workspace) |

These roll up daily into `data_quality_snapshots` (existing, migration 0031) so the fleet view in
[`10`](./10-Monitoring-and-Observability.md) and the customer dashboard read the same ledger. **Recompute on
every change** (02 dim 10): the on-demand sweep and the import-completion fan-out both refresh the affected
contacts' sub-scores.

---

## 6. Implementation Steps (sequenced)

1. **Operator registry + evaluator** (`packages/core/src/data-health/validation/`): `operators.ts` (closed
   op set), `patternLibrary.ts` (named vetted regexes), `evaluate.ts` (pure: `(rule, row, ctx) → result`),
   `runStages.ts` (orders stages, short-circuits on `block`). Pure functions, no DB — unit-testable.
2. **Schema + migration ~0035** (§8): `validation_rule_sets`, `validation_rules`, `validation_runs`,
   `validation_results`; add `reject_code` + `reject_rule_id` columns to `import_job_rows`; RLS policies for
   the workspace-scoped tables.
3. **Repository layer** (`packages/db/src/repositories/validationRepository.ts`): CRUD on rule sets/rules
   inside `withTenantTx`; report read inside `withTenantTx`; the cross-tenant staff template publish inside
   `withPlatformTx` (audited).
4. **Import pipeline integration** (`packages/core/src/import/runImport.ts` + `runBulkImport.ts`): insert the
   `validating` stage; write `validation_runs`/`validation_results`; park at `staged`; gate
   `staged → running` on an accept decision. Tie to [`05`](./05-Upload-Pipeline-Design.md).
5. **On-demand sweep worker** (`apps/workers`): new `validation-sweep` queue + `.dlq`, leader-locked enqueue
   helper `enqueueValidationSweep`; consumer reads scope inside `withTenantTx`, writes `validation_runs`.
6. **Quality sub-score extension** (`@leadwolf/types` `dataHealth.ts` + `dataQualityScore.ts` re-export): add
   `accuracy`/`consistency`/`validity`/`uniqueness`; wire into `dataQualitySnapshot.ts`.
7. **API routers** (§9): customer `/api/v1/validation/*` (workspace-scoped, `requireOrgRole`); staff
   `/api/v1/admin/data/validation/*` (`requireCapability('data:manage'|'data:review')`, `withPlatformTx`).
8. **New staff capabilities** (`packages/types/src/staffCapability.ts`): `data:read`, `data:manage`,
   `data:review`, `data:export`; bundle into roles in `ROLE_CAPABILITIES`. (Shared with
   [`11-Roles-and-Permissions`](./11-Roles-and-Permissions.md).)
9. **Admin feature folder** `apps/admin/src/features/data-validation/` (mirrors `features/retention`):
   `api.ts`, `types.ts`, `hooks/useRuleSets.ts`/`useValidationReport.ts`/`useRejectTriage.ts`,
   `components/ValidationPage.tsx` (Tabs: Rule Sets | Reports | Reject Triage). Register a **Data
   management** nav group destination in `navConfig.ts`.
10. **Customer feature folder** `apps/web/src/features/data-health/validation/` reusing the same `api.ts`
    seam against `/api/v1/validation/*`.
11. **Formula-injection flag** (`row.schema` + `row.format` op `formulaInjectionFree`): **flag only** here;
    export-time neutralization is owned by [`12`](./12-Security-and-Compliance.md).
12. **Tests** (§11): operator unit tests, evaluator stage-ordering tests, the **mandatory tenant-isolation
    itest** on every write path, and a report-snapshot integration test.

---

## 7. UI/UX Requirements

Two surfaces, one component vocabulary (`@leadwolf/ui`). Every screen implements the **four states** via
`StateSwitch` (`loading` → `LoadingState`/`Skeleton`; `empty` → `EmptyState`; `error` → `ErrorState` reading
the RFC-7807 `detail` via `problemMessage`; `data` → the table/form). Hooks are hand-rolled
`useState`/`useEffect` returning `{data, loading, error, reload}` (no TanStack) per the admin pattern.

### 7.1 Rule Builder (staff & customer)

Components: `Tabs`, `DataTable`+`Column<Rule>`, `Drawer` (rule editor), `TpSelect` (stage/severity/op),
`Combobox` (field, pattern-id), `TpInput`/`TpTextarea` (args, description), `TpSwitch` (active),
`StatusBadge`+`StatusTone` (severity → tone: block=`danger`, warn=`warning`, info=`neutral`), `TpButton`,
`useToast`. High-risk publish (staff → global template) uses the `Dialog` + mandatory justification-reason
pattern from `features/tenants/components/TenantActions.tsx`.

```
┌─ Data management ▸ Validation ───────────────────────────────────────────────┐
│ [ Rule Sets ]  [ Reports ]  [ Reject Triage ]                  v7 · Active ●  │
├──────────────────────────────────────────────────────────────────────────────┤
│ Rule set: Contacts — Default (workspace)        [ + New rule ]  [ Publish ▾ ] │
│ ┌───┬──────────────┬───────────────┬──────────┬──────────┬──────────┬──────┐ │
│ │ # │ Stage        │ Field         │ Operator │ Severity │ Action   │ On ● │ │
│ ├───┼──────────────┼───────────────┼──────────┼──────────┼──────────┼──────┤ │
│ │ 1 │ schema       │ email|li_id   │ oneOf    │ ▮ block  │ reject   │  ●   │ │
│ │ 2 │ row.format   │ email         │ matches  │ ▮ block  │ reject   │  ●   │ │
│ │ 3 │ row.business │ email_status  │ emailTier│ ▮ warn   │ flag     │  ●   │ │
│ │ 4 │ row.crossfield│ email_domain │ domain…  │ ▮ warn   │ flag     │  ●   │ │
│ │ 5 │ row.unique   │ email_bidx    │ unique   │ ▮ block  │ reject   │  ●   │ │
│ │ 6 │ aggregation  │ —             │ range    │ ▮ block  │ reject*  │  ●   │ │
│ └───┴──────────────┴───────────────┴──────────┴──────────┴──────────┴──────┘ │
│  * reject whole file if rejected/total > 0.20                                 │
└──────────────────────────────────────────────────────────────────────────────┘
   Drawer (edit rule 3) ▸  Field: email_status  Op: emailTier
   Allowed tiers: [✓ valid] [ catch_all ] [ unknown ]   Severity: ( ) block (●) warn
   Note: unknown/catch_all are NEVER promoted to valid by a rule (verifier-only).
```

- **Empty:** `EmptyState` "No rule sets yet — start from a template" + `TpButton` "Use default template".
- **Loading:** `Skeleton` rows in the `DataTable`.
- **Error:** `ErrorState` with `problemMessage(res, "Couldn't load rule sets")` + Retry.
- **Data:** the table above; drag-to-reorder writes a new rule-set version (§7.4 versioning).

### 7.2 Validation Report (pre-commit gate)

Components: `StatTile` (counts by severity), `DataTable` (per-rule rollup with sample drill via `Drawer`),
`StatusBadge`, `SegmentedControl` (severity filter), `TpButton` (Accept & import / Reject file),
`Tooltip`, `Pagination` (samples, keyset).

```
┌─ Import #4821 ▸ Validation report  (job: staged · awaiting decision) ─────────┐
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐    Reject ratio 2.49%     │
│ │ Total    │ │ ▮ Block  │ │ ▮ Warn   │ │ ▮ Info   │    Verdict: PASS ✓        │
│ │ 48,211   │ │ 1,204    │ │ 3,380    │ │ 9,120    │    (threshold 20%)        │
│ └──────────┘ └──────────┘ └──────────┘ └──────────┘                            │
│ [ All ] [ Block ] [ Warn ] [ Info ]                                            │
│ ┌─────────────────┬──────────┬────────┬───────────────── sample ───────────┐ │
│ │ Rule code       │ Severity │ Count  │ row 17: "joe@@acme" → bad format    │ │
│ │ email.format    │ ▮ block  │   902  │ row 88: "n/a"       → bad format    │ │
│ │ email.uniqueness│ ▮ block  │   300  │ …                                    │ │
│ │ email.tier      │ ▮ warn   │ 3,380  │ row 12: status=unknown (not promoted)│ │
│ └─────────────────┴──────────┴────────┴──────────────────────────────────────┘ │
│        [ Reject file ]                        [ Accept & import 47,007 rows ]  │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Empty:** "No failures — all 48,211 rows passed" `EmptyState` (success tone) with Accept enabled.
- **Loading / Error:** `StateSwitch` standard.
- **Data:** Accept transitions `staged → running`; Reject sets job `cancelled` and offers the rejects CSV.

### 7.3 Reject Triage

Components: `DataTable`+`Column`, `StatusBadge`, `DropdownMenu` (per-group actions), `Dialog` (re-map),
`Drawer` (inspect a row's input jsonb + the failing rule), `Pagination` (keyset), `useToast`.

```
┌─ Data management ▸ Validation ▸ Reject Triage ───────────────────────────────┐
│ Job #4821 · 1,204 rejected · grouped by reason         [ Download rejects ⤓ ] │
│ ┌─ reason code ───────────┬─ count ─┬─ stage ──────┬─ actions ─────────────┐ │
│ │ email.format            │   902   │ row.format   │ [Re-map][Correct][×]  │ │
│ │ email.uniqueness        │   300   │ row.unique   │ [Inspect][Dismiss]    │ │
│ │ account.referential     │     2   │ row.referential [Inspect]            │ │
│ └─────────────────────────┴─────────┴──────────────┴───────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Empty:** "No rejects to triage" `EmptyState`.
- Re-map opens a `Dialog` to fix the column mapping and re-validate **only the rejected subset** (a child
  job). Correct opens a `Drawer` to edit sampled values; re-submit is idempotency-keyed.

---

## 8. Database & Backend Changes

**Reused as-is:** `import_jobs`, `import_job_chunks`, `import_job_rows` (schema/importJobs.ts; migration
0032), `contacts`/`accounts` (`field_provenance`, `email_status`, `email_blind_index`),
`data_quality_snapshots` (migration 0031), `audit_log` (writeAudit) and `platform_audit_log` (withPlatformTx).

**New tables — the next sequential migration (0035+), assigned at implementation time (several docs add
migrations in the same phase)** (4-digit + drizzle slug; schema files under
`packages/db/src/schema/validation.ts`; `drizzle.config.ts` strict; journal `_journal.json` appended). All
four customer tables are **workspace-scoped, RLS ENABLE+FORCE**, written exclusively via
**`withTenantTx`** (customer/self-serve) or **`withPlatformTx`** (staff cross-tenant, audited). RLS policy
mirrors the package idiom: `USING/WITH CHECK workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid`.

```sql
-- ── validation_rule_sets ───────────────────────────────────────────────────
CREATE TABLE validation_rule_sets (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id)    ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity        varchar(20)  NOT NULL,           -- 'contact' | 'account'
  surface       varchar(20)  NOT NULL,           -- 'import' | 'on_demand' | 'write_path'
  name          varchar(160) NOT NULL,
  version       integer      NOT NULL DEFAULT 1, -- bumped on any rule change (immutable snapshots)
  is_active     boolean      NOT NULL DEFAULT false,
  template_id   uuid,                            -- audit pointer to a published staff template (no FK)
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT validation_rule_sets_entity_enum  CHECK (entity  IN ('contact','account')),
  CONSTRAINT validation_rule_sets_surface_enum CHECK (surface IN ('import','on_demand','write_path'))
);
-- one ACTIVE set per (workspace, entity, surface); history rows stay with is_active=false
CREATE UNIQUE INDEX uniq_vrs_ws_entity_surface_active
  ON validation_rule_sets (workspace_id, entity, surface)
  WHERE is_active;
CREATE INDEX idx_vrs_ws ON validation_rule_sets (workspace_id, entity, surface);

-- ── validation_rules ───────────────────────────────────────────────────────
CREATE TABLE validation_rules (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  rule_set_id   uuid NOT NULL REFERENCES validation_rule_sets(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, -- denormalized for direct RLS
  ordinal       integer      NOT NULL,           -- evaluation order within a stage
  stage         varchar(24)  NOT NULL,           -- file|schema|row.required|row.type|row.format|
                                                 -- row.range|row.uniqueness|row.referential|
                                                 -- row.business|row.crossfield|aggregation
  code          varchar(64)  NOT NULL,           -- stable machine id, e.g. 'email.format'
  field         varchar(64),                     -- target column; null for aggregation/file
  op            varchar(32)  NOT NULL,           -- closed operator-registry key
  args          jsonb        NOT NULL DEFAULT '{}'::jsonb,
  severity      varchar(10)  NOT NULL,           -- block | warn | info
  action        varchar(12)  NOT NULL,           -- reject | flag | score_only | normalize
  is_active     boolean      NOT NULL DEFAULT true,
  CONSTRAINT validation_rules_stage_enum    CHECK (stage IN (
     'file','schema','row.required','row.type','row.format','row.range','row.uniqueness',
     'row.referential','row.business','row.crossfield','aggregation')),
  CONSTRAINT validation_rules_severity_enum CHECK (severity IN ('block','warn','info')),
  CONSTRAINT validation_rules_action_enum   CHECK (action   IN ('reject','flag','score_only','normalize'))
);
CREATE UNIQUE INDEX uniq_vr_set_code ON validation_rules (rule_set_id, code);
CREATE INDEX idx_vr_set_stage_ord ON validation_rules (rule_set_id, stage, ordinal);

-- ── validation_runs — one per import-validation pass OR on-demand sweep ──────
CREATE TABLE validation_runs (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id)    ON DELETE CASCADE,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  rule_set_id     uuid NOT NULL,                  -- audit pointer (no FK; set may be archived)
  rule_set_version integer NOT NULL,              -- the exact version evaluated (audit trail; 02 dim 11)
  trigger         varchar(16) NOT NULL,           -- 'import' | 'on_demand'
  import_job_id   uuid,                            -- audit pointer when trigger='import' (no FK)
  scope           jsonb NOT NULL DEFAULT '{}'::jsonb, -- {listId|savedSearchId|all} for on_demand
  rows_total      integer NOT NULL DEFAULT 0,
  count_block     integer NOT NULL DEFAULT 0,
  count_warn      integer NOT NULL DEFAULT 0,
  count_info      integer NOT NULL DEFAULT 0,
  reject_ratio    numeric(6,5) NOT NULL DEFAULT 0,
  aggregation_verdict varchar(16) NOT NULL DEFAULT 'pass', -- pass | reject_file | warn
  decision        varchar(12) NOT NULL DEFAULT 'pending',  -- pending | accepted | rejected
  decided_by      uuid REFERENCES users(id),
  samples_capped  boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz,
  CONSTRAINT validation_runs_trigger_enum  CHECK (trigger  IN ('import','on_demand')),
  CONSTRAINT validation_runs_decision_enum CHECK (decision IN ('pending','accepted','rejected'))
);
CREATE INDEX idx_vrun_ws_created ON validation_runs (workspace_id, created_at DESC);

-- ── validation_results — capped sample failures + per-rule rollup ───────────
CREATE TABLE validation_results (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  run_id        uuid NOT NULL REFERENCES validation_runs(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, -- direct RLS
  rule_code     varchar(64) NOT NULL,
  stage         varchar(24) NOT NULL,
  severity      varchar(10) NOT NULL,
  count         integer NOT NULL DEFAULT 0,        -- per-(run,rule) total
  sample_row_index integer,                        -- null on the rollup row; set on sample rows
  sample_value  text,                              -- redacted/truncated offending value (no raw PII dumps)
  sample_message text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_vresult_run_rule ON validation_results (run_id, rule_code);

-- ── import_job_rows: codify the reject reason (additive) ────────────────────
ALTER TABLE import_job_rows ADD COLUMN reject_code    varchar(64); -- = the failing rule code
ALTER TABLE import_job_rows ADD COLUMN reject_rule_id uuid;        -- audit pointer to validation_rules (no FK)
CREATE INDEX idx_import_job_rows_reject_code ON import_job_rows (workspace_id, reject_code)
  WHERE reject_code IS NOT NULL;
```

**Global staff template library** (`validation_rule_set_templates`, `validation_rule_templates`) is
**system-owned, NOT RLS-scoped** (it has no `workspace_id`); it is read by any workspace and written only via
`withPlatformTx` (audited, `pa` claim verified). Publishing a workspace set as a template, or pushing a
template into a tenant, is a **cross-tenant write → `withPlatformTx`** and writes a `platform_audit_log` row
in the same transaction. (DDL analogous; omitted for brevity — same idiom minus the tenancy columns.)

**Tx-wrapper posture (Platform owns tenancy):**

| Operation | Wrapper | Why |
|---|---|---|
| Customer authors/edits a rule set in their workspace | `withTenantTx` | RLS-scoped, ownership-checked |
| Customer/on-demand sweep reads + writes runs/results | `withTenantTx` | same |
| Staff reads any tenant's runs (oversight) | `withPlatformTx` | audited cross-tenant read |
| Staff publishes/pushes a global template into a tenant | `withPlatformTx` | audited cross-tenant write |
| Bulk COPY staging table evaluation | runs inside the existing import tx; staging COPY uses `ownerClient` only for the COPY itself (RLS tables forbid COPY) | unchanged from [`05`](./05-Upload-Pipeline-Design.md) |

A multi-tenant write without an RLS-enforced, ownership-checked, **audited** path is a bug — never a style
choice ([`12`](./12-Security-and-Compliance.md) has final say).

---

## 9. API Requirements

RFC 9457 problem envelope (`middleware/error.ts`); shared Zod parsed at the edge with `safeParse`, responses
re-`parse`d; scope **always** from the verified token (`c.get('tenantId')`/`workspaceId`/`claims.sub`),
**never** the body; keyset pagination (`packages/types/src/search.ts`, `limit 1..200 default 50 → nextCursor`).

### 9.1 Customer self-service (`/api/v1/validation/*`) — gate `requireOrgRole`, `withTenantTx`

| Method · Path | Request (Zod) | Response | Errors | Idem | Page |
|---|---|---|---|---|---|
| `GET /validation/rule-sets` | `?entity&surface` | `{ ruleSets: RuleSet[] }` | — | — | — |
| `POST /validation/rule-sets` | `{ entity, surface, name }` | `{ ruleSet }` | `ValidationError 422` | — | — |
| `PUT /validation/rule-sets/:id` | `{ name?, isActive?, rules: RuleInput[] }` (full replace ⇒ **version bump**) | `{ ruleSet, version }` | `ValidationError 422`, `NotFoundError 404`, `ConflictError 409` (active-set collision) | `Idempotency-Key` | — |
| `POST /validation/rule-sets/:id/clone-from-template` | `{ templateId }` | `{ ruleSet }` | `NotFoundError 404` | — | — |
| `GET /validation/runs` | `?cursor&limit&trigger` | `{ runs: RunSummary[], nextCursor }` | — | — | keyset |
| `GET /validation/runs/:id` | — | `ValidationReport` (§5.4) | `NotFoundError 404` | — | — |
| `GET /validation/runs/:id/results` | `?severity&cursor&limit` | `{ results: ResultSample[], nextCursor }` | `NotFoundError 404` | — | keyset |
| `POST /validation/runs/:id/decision` | `{ decision: 'accepted'\|'rejected' }` | `{ run, jobStatus }` | `NotFoundError 404`, `ConflictError 409` (already decided) | `Idempotency-Key` | — |
| `POST /validation/sweeps` | `{ ruleSetId, scope: {listId?\|savedSearchId?\|all:true} }` | `{ runId, status:'queued' }` | `ValidationError 422` | `Idempotency-Key` | — |
| `GET /validation/import-jobs/:jobId/rejects` | `?cursor&limit&rejectCode` | `{ rows: RejectRow[], byCode: {code,count}[], nextCursor }` | `NotFoundError 404` | — | keyset |
| `POST /validation/import-jobs/:jobId/rejects/resubmit` | `{ rejectCode?, columnMapping?, corrections? }` | `{ childJobId }` | `ValidationError 422` | `Idempotency-Key` (parent+reject-hash) | — |

### 9.2 Staff console (`/api/v1/admin/data/validation/*`) — gate `platformAdmin` + `requireCapability`, `withPlatformTx`

| Method · Path | Capability | Request | Response | Notes |
|---|---|---|---|---|
| `GET /admin/data/validation/templates` | `data:read` | — | `{ templates }` | global library |
| `POST /admin/data/validation/templates` | `data:manage` | `{ name, entity, surface, rules }` | `{ template }` | audited publish |
| `POST /admin/data/validation/templates/:id/push` | `data:manage` | `{ tenantId, workspaceId }` | `{ ruleSetId }` | cross-tenant write → audited; high-risk ⇒ **JIT elevation + maker/checker** ([`09`](./09-Review-and-Approval-System.md)) |
| `GET /admin/data/validation/runs` | `data:read` | `?tenantId&workspaceId&cursor&limit` | `{ runs, nextCursor }` | cross-tenant oversight |
| `GET /admin/data/validation/reject-triage` | `data:review` | `?cursor&limit&rejectCode` | `{ groups, rows, nextCursor }` | fleet reject view |

New capabilities `data:read`/`data:manage`/`data:review`/`data:export` are added to
`packages/types/src/staffCapability.ts` (currently a closed 16-member enum with **no `data:*`**) and bundled
in `ROLE_CAPABILITIES` — owned jointly with [`11-Roles-and-Permissions`](./11-Roles-and-Permissions.md).
`PUT rule-sets/:id` is **idempotency-keyed** because a version bump must not double-apply on retry; the DB
`uniq_vrs_ws_entity_surface_active` partial index is the real guard.

---

## 10. Edge Cases & Failure Scenarios

| # | Scenario | Handling |
|---|---|---|
| E1 | **Conflicting rules** (two rules on the same field, one `block` one `flag`). | Evaluate in `(stage, ordinal)` order; severity precedence `block > warn > info` — the row's outcome is the **highest** severity that fired. A `block` short-circuits remaining rules *for that row* but the report still records all rule hits up to the block for triage. |
| E2 | **Rule versioning / decision audit.** | `validation_runs.rule_set_version` snapshots the exact version evaluated; rule-set edits create a new version (old rows stay `is_active=false`). Re-running an old import re-uses its recorded version, so an audit answers "which rule@version rejected row N" (02 dim 11/12). |
| E3 | **Huge reject sets** (e.g. 2M rejects). | `validation_results` stores **capped samples** (default 50 per rule code) + the rollup count; `samples_capped=true` signals truncation. Full rejects remain the streamed `rejected_artifact_key` CSV; triage paginates by keyset, never offset. Aggregation stage can `reject_file` before per-row sampling explodes. |
| E4 | **Aggregation threshold ambiguity** (partial-accept vs whole-file-reject). | Encoded as an `aggregation`-stage rule with `range(reject_above)` — a *policy choice keyed on sensitivity* (02 dim 19), not a constant. Default `reject_above=0.20`, `warn_above=0.05`. |
| E5 | **`email_status` promotion attempt.** | Structurally impossible: validation actions (`reject`/`flag`/`score_only`/`normalize`) cannot write the `email_status` enum; only the verifier promotes. A rule authoring `emailTier` that *includes* `unknown` in the deliverable set is allowed only at `warn`/`info` severity, never `block`-to-promote (there is no promote action). |
| E6 | **Referential/uniqueness rule races** (a referenced list deleted mid-validation). | `references()`/`unique()` evaluate inside the same `withTenantTx` snapshot; a row passing validation but failing the real DB constraint at promote-time falls back to the codified 23505 → `reject_code='email.uniqueness'` so triage stays consistent. |
| E7 | **Rule set with zero active rules.** | The default-template fallback applies; an explicitly empty active set passes everything but emits a `warn` report banner "No active validation rules — all rows accepted unvalidated." |
| E8 | **CSV formula-injection** in a cell (`=cmd`, `+`, `-`, `@`, leading tab/CR). | `formulaInjectionFree` op **flags** (severity `warn`, action `flag`) at ingest and annotates `field_provenance`; **enforcement/neutralization on export is deferred to [`12-Security-and-Compliance`](./12-Security-and-Compliance.md#58-file-upload-hardening-the-upload-pipeline)** — Security owns the boundary. |
| E9 | **Operator submits an unknown op/regex.** | Edge `safeParse` rejects ops outside the closed registry (`ValidationError 422`); `matches` only accepts a pattern-id from the vetted library, never a raw regex (no ReDoS). |
| E10 | **Sweep over a workspace mid-import.** | The sweep reads committed `contacts` only; in-flight staged rows are invisible (not yet promoted), so no double-count. |
| E11 | **Decision replay** (operator double-clicks Accept). | `POST .../decision` is idempotency-keyed; second call returns the first result; `409 ConflictError` if a *different* decision is attempted after one is recorded. |

---

## 11. Testing Strategy

**Unit** (`packages/core` + `@leadwolf/types`, Bun test):
- Operator registry: each op (`present`/`range`/`emailTier`/`unique`/`references`/`domainMatchesEmail`/
  `formulaInjectionFree`/`notFuture`) — true/false/edge inputs.
- `emailTier` **non-promotion** test: assert no rule path can output `email_status='valid'` from
  `unknown`/`catch_all`.
- Stage ordering + short-circuit: a `block` in `row.format` prevents `row.business` from firing on that row.
- Severity precedence (E1) and aggregation verdict math (E4).
- Quality sub-score extension: `accuracy`/`consistency`/`validity`/`uniqueness` derive correctly from
  result counts; range floors above zero (02 dim 10).

**Integration** (`apps/api`, against a real PG with RLS):
- `PUT rule-sets/:id` bumps version, flips `is_active`, and the partial unique index prevents two active sets.
- Report read returns the snapshotted `rule_set_version`.
- Decision endpoint transitions the import job `staged → running` on accept, `cancelled` on reject.
- Idempotent decision + resubmit (E11) replay first response.

**itest — MANDATORY tenant-isolation** (every path that *writes*): assert a `withTenantTx` scoped to
workspace A **cannot read or write** workspace B's `validation_rule_sets`/`validation_runs`/
`validation_results` (RLS USING/WITH CHECK on `workspace_id`); assert a missing/empty
`app.current_workspace_id` GUC **fails closed** (NULLIF empty); assert the staff `withPlatformTx` template
push writes a `platform_audit_log` row in the same transaction. This is non-negotiable per CLAUDE.md and
[`12`](./12-Security-and-Compliance.md).

**Fixtures:** a golden CSV with known counts per reject code feeds a report-snapshot test so the UI's
`StatTile`/`DataTable` numbers are regression-locked.

---

## 12. Rollout & Migration Plan

1. **Migration ~0035** ships the four workspace tables (RLS ENABLE+FORCE) + the global template tables +
   the two `import_job_rows` columns. Additive only; no backfill of existing rejects required (legacy
   `reject_reason` text remains readable; `reject_code` is null for pre-existing rows and the triage UI
   degrades gracefully to "uncategorized").
2. **Capability rollout** (`data:read`/`data:manage`/`data:review`/`data:export`) lands with
   [`11`](./11-Roles-and-Permissions.md); until bundled, only `super_admin` (implies all) can author.
3. **Feature flag** `validation_framework_enabled` (per-tenant, fail-closed via `isFlagEnabledForTenant`,
   seeded `false` like the bulk-import flags at `packages/config/src/env.ts`). Phasing:
   - **Shadow:** rules evaluate and write `validation_runs`/`validation_results` but **do not gate** imports
     (every job auto-accepts) — proves the engine against real traffic with zero behavior change. Mirrors
     the retention engine's inert-shadow posture.
   - **Canary:** enable the *human gate* (import parks at `staged`) for a handful of internal/design-partner
     workspaces; ship the default contact/account templates.
   - **GA:** flip per-tenant; customer self-service rule authoring opens.
4. **On-demand sweeps** stay opt-in (a button) throughout — no automatic mass re-validation that could
   surprise a tenant's quality dashboard.
5. **Rollback:** non-destructive. Disabling the flag reverts imports to auto-accept; `validation_runs`
   history is preserved (recomputable, per 02 dim 12). No data is mutated by validation (`flag`/`score_only`
   only), so there is nothing to un-write.

---

## 13. Success Metrics & Acceptance Criteria

**Metrics** ([`10-Monitoring-and-Observability`](./10-Monitoring-and-Observability.md)): pre-commit reject
ratio per import; per-rule fire rate; reject-triage resolution time; per-dimension quality sub-scores trend
(`accuracy/completeness/consistency/timeliness/validity/uniqueness`) in `data_quality_snapshots`; share of
imports passing through the human gate vs auto-rejected at aggregation.

**Acceptance criteria** (testable checklist):

- [ ] **AC1** — A `validation_rule_sets` row + ≥1 `validation_rules` row can be authored via
  `PUT /validation/rule-sets/:id`, scoped to the caller's workspace, inside `withTenantTx`.
- [ ] **AC2** — Editing a rule set **bumps `version`** and the **partial unique index** prevents two active
  sets per `(workspace, entity, surface)`.
- [ ] **AC3** — An import job evaluates the active rule set in the `validating` stage, writes a
  `validation_runs` row with correct `count_block/warn/info` and `reject_ratio`, and **parks at `staged`**.
- [ ] **AC4** — The pre-commit report API returns counts by severity, per-rule rollup, and capped samples;
  `samples_capped` is set when truncated.
- [ ] **AC5** — Accepting the report transitions `staged → running`; rejecting sets `cancelled`; the action
  is idempotency-keyed.
- [ ] **AC6** — Rejected rows land in `import_job_rows` with `outcome='rejected'` **and a codified
  `reject_code`**, queryable by code via `idx_import_job_rows_reject_code`.
- [ ] **AC7** — The reject-triage queue groups by `reject_code`, supports keyset pagination, and re-submit
  creates an idempotency-keyed child job.
- [ ] **AC8** — **No code path** promotes `email_status` `unknown`/`catch_all` → `valid` via a validation
  rule (unit test proves it; only the verifier promotes).
- [ ] **AC9** — Quality sub-scores `accuracy/consistency/validity/uniqueness` are computed from rule outcomes
  and roll into `data_quality_snapshots`; range floors above zero.
- [ ] **AC10** — **Tenant-isolation itest passes**: workspace A cannot read/write workspace B's validation
  rows; empty GUC fails closed; staff template push writes a `platform_audit_log` row in the same tx.
- [ ] **AC11** — Staff template publish/push requires `data:manage` (or `data:review` for triage), goes
  through `withPlatformTx`, and high-risk push requires JIT elevation + maker/checker
  ([`09`](./09-Review-and-Approval-System.md)).
- [ ] **AC12** — CSV formula-injection is **flagged** at ingest (`warn`); enforcement on export is owned by
  [`12`](./12-Security-and-Compliance.md) (not regressed here).
- [ ] **AC13** — With the flag in **shadow**, imports auto-accept while `validation_runs` are still written
  (zero behavior change); flipping to **canary** activates the human gate.

---

### Cross-references

[`01-Current-State-Analysis`](./01-Current-State-Analysis.md) ·
[`02-Enterprise-Research`](./02-Enterprise-Research.md) ·
[`03-Gap-Analysis`](./03-Gap-Analysis.md) ·
[`04-Control-Panel-Architecture`](./04-Control-Panel-Architecture.md) ·
[`05-Upload-Pipeline-Design`](./05-Upload-Pipeline-Design.md) ·
[`07-Deduplication-and-Linking`](./07-Deduplication-and-Linking.md) ·
[`08-Data-Enrichment-Workflow`](./08-Data-Enrichment-Workflow.md) ·
[`09-Review-and-Approval-System`](./09-Review-and-Approval-System.md) ·
[`10-Monitoring-and-Observability`](./10-Monitoring-and-Observability.md) ·
[`11-Roles-and-Permissions`](./11-Roles-and-Permissions.md) ·
[`12-Security-and-Compliance`](./12-Security-and-Compliance.md) ·
[`13-Performance-and-Scaling`](./13-Performance-and-Scaling.md) ·
[`14-Implementation-Roadmap`](./14-Implementation-Roadmap.md) ·
[`15-Future-Enhancements`](./15-Future-Enhancements.md)
