# 05 — Multi-Value Channel Architecture (phones & emails)

> **Status:** 🟡 drafted (design doc — no code, no migrations ship from this series).
> **Owns:** the full end-to-end specification of the overlay child tables `contact_phones` and
> `contact_emails` — columns, constraints, RLS, the E.164 pipeline, the primary-cache
> synchronization contract, search/masking, import/dedup touchpoints, soft-delete, and the
> migration step IDs (`S-CH*`).
> **Gap ownership:** **G15** (no multi-value channels anywhere — P0) and **G16**
> (secondaries-searchable guard — P1) per [`02 §Register`](02-Root-Cause-and-Gap-Analysis.md).
> **Siblings:** [`04-Contact-Schema-Design.md`](04-Contact-Schema-Design.md) owns the contact
> core + the merge contract these tables are a prerequisite for (G20); doc
> [`06-Company-Schema-Design.md`](06-Company-Schema-Design.md) applies the same
> child-table-plus-primary-cache pattern to `account_domains`. Doc `07` consolidates the ER
> view; doc `15` sequences the `S-CH*` steps.

---

## Objective

Let a contact carry **unlimited phones and emails** — each value individually typed, verified,
provenance-tracked, pinnable, and soft-deletable — without breaking anything the product
already builds on the single flat encrypted columns: per-workspace dedup, blind-index lookup,
the masked-until-reveal contract, COPY-staging import, and search facets. This is the fix for
RC-4 (02 §RC-4): today an import of a dataset with mobile + direct + HQ columns silently drops
two of the three numbers, and enrichment has nowhere to put a second verified channel, so paid
data is discarded.

---

## Reconciliation

Pinned to shipped code and locked decisions before any design claim:

1. **The as-is (01 §6.2, re-verified for this doc):** contacts hold exactly one email and one
   phone as flat encrypted columns — `email_enc`/`email_blind_index`/`email_domain`/
   `email_status`, `phone_enc`/`phone_status`/`phone_line_type`
   (`packages/db/src/schema/contacts.ts:120–136`); per-workspace dedup rides the partial
   uniques led by `(workspace_id, email_blind_index)` (`contacts.ts:187–195`). The Layer-0
   channel tables are shape-only — blind index + domain, `email_enc = NULL`, never read by
   app code (01 §6.2, correction 2).
2. **DM1 — one canonical primitive set** (`../data-management/00-overview.md` §DM1). The
   normalizers and crypto this doc reuses, verbatim, are: `normalizeEmailForStorage`/
   `normalizeEmailForIndex`/`emailDomainOf` (`packages/core/src/import/normalize.ts:16–36`),
   `blindIndex` — HMAC-SHA256 keyed by `env.BLIND_INDEX_KEY`
   (`packages/core/src/import/blindIndex.ts:10–12`), `encryptPii` — AES-256-GCM,
   `iv(12)|authTag(16)|ct` layout (`packages/core/src/import/encryptPii.ts:12–17`), and —
   decisive for phones — **`toE164` already ships**: libphonenumber-js parse with a
   `defaultRegion` knob (`packages/core/src/enrichment/matchKeys.ts:87–95`; the dependency is
   already in `packages/core/package.json`). No second normalizer is introduced anywhere in
   this design; `prepareContact` (`packages/core/src/import/prepareContact.ts:38–77`) is
   *extended*, never forked.
3. **DM4 — tenancy unchanged.** The child tables are Layer-1 overlay tables: non-null
   `tenant_id` + `workspace_id`, `ENABLE`+`FORCE` RLS on the fail-closed workspace GUC,
   reached only via `withTenantTx`. No user GUC, no new roles, no Layer-0 change.
4. **DM6 — provenance is one JSONB winner-map, and it keeps governing the flat cache.**
   Shipped code *already anticipates this doc*: the pin-protected scalar set
   `CONTACT_PROVENANCE_FIELDS` excludes email/phone because "channel provenance is DEFERRED to
   the reveal/channel layer" (`packages/types/src/fieldProvenance.ts:50–62`); DM6 names that
   deferred layer explicitly (`00-overview.md` §DM6). **The child tables specified here ARE
   that channel layer** — they fulfill the DM6 seam rather than competing with it. (DM6 and the
   code comment carry the era's working name for it, `revealed_channels` "Phase 4";
   `contact_emails`/`contact_phones` supersede that *name* — a naming refinement of the same
   reserved seam, not a second design.) §Cache
   contract below specifies the division precisely: the winner-map governs *which value holds
   the primary cache slot*; child rows carry *per-value* provenance.
5. **Status vocabularies are reused, never re-derived** (DM1): `email_status` =
   `unverified|valid|risky|invalid|catch_all|unknown` (`packages/types/src/contacts.ts:24–32`,
   CHECK at `schema/contacts.ts:196–199`); `phone_status` =
   `direct|mobile|hq|unknown|valid|invalid` (`types/contacts.ts:34–35`); `phone_line_type`
   base enum `mobile|landline|voip|unknown` (`types/contacts.ts:39–40`) — extended
   *additively* below, one vocabulary, not a second.
6. **The bulk-staging ciphertext rule** (`../data-management/15-bulk-import-design.md` §1):
   staging carries the *already-prepared* row — ciphertext + blind index computed before
   COPY — so PII is encrypted even in the non-RLS UNLOGGED staging table. Child-row values
   must be COPY-compatible under the same rule (§Import touchpoints).
7. **Layer-0 stays untouched.** `master_emails`/`master_phones` are not modified, joined, or
   projected by this design. The future knowledge-DB projection
   (`../prospect-database-platform/05-Internal-Knowledge-Database.md`) **feeds** these child
   tables (as one more `source`-labelled writer through the same write path), never replaces
   them (series README §Relationship).
8. **Masked-until-reveal is the shipped read contract**: `maskedContactSchema` exposes
   presence booleans, statuses, and the domain facet — never values
   (`packages/types/src/contacts.ts:374–411`). §Search below extends it without weakening it.

### The decision, restated, with the rejected alternatives

**Decided (program brief, Architecture spine):** overlay child tables `contact_phones` and
`contact_emails`; the existing flat encrypted columns are retained **permanently** as the
denormalized primary-value cache.

- **Rejected — project Layer-0 master channels into the overlay.** Path-isolated (`withErTx`
  only, no tenancy columns — DM4 forbids adding them); holds no values today (01 §6.2); and a
  projection is read-only intelligence — it cannot absorb workspace-local writes (a rep adding
  a second phone, pinning it, marking it bad), which is the actual product need (02 §RC-4
  "why it came to be").
- **Rejected — replace the flat columns with child rows ("pure" normalization).** Dedup
  (`uniq_contacts_ws_email`), `findByDedupKeys`, search facets, the masked contract, the
  COPY-staging encoder, and the reveal read path are all built on the flat columns
  (01 §6.2–6.3); dropping them is a big-bang cutover with no rollback lever. Decisive
  external evidence: **both** market leaders run the dual shape — Salesforce keeps the flat
  columns on `Contact` *alongside* ContactPoint\* (03 §3.1 [41][44]); HubSpot runs one
  primary property + a computed secondary list [10]. The flat primary cache is not legacy
  debt; it is the industry-proven read/dedup hot path (03 §3.3).
- **Why child rows are where quality lives:** per-value verification and provenance survive
  in no unified/flattened representation — Merge/Apideck/Nango all drop them in flattening
  (03 §3.1 [127][132][133], §3.2 matrix bottom row). If TruePoint wants per-value
  `status`/`confidence`/`source`/`pinned` — and the enrichment product requires it — those
  facts can only live on owned child rows.

### Contradiction scan

No conflict found with DM1–DM9, ADR-0028, `data-management/15`, or the shipped
`staffCapability.ts` (staff caps are not touched — this is entirely a Surface-2/`apps/web`
data-model concern). One refinement of the program brief's shorthand is flagged inline:
§Migration orders dual-write *before* backfill (the brief's summary listed backfill first);
and §Constraints scopes the phone dedup unique per-contact rather than per-workspace, with
the workspace-level phone collision kept as a *match signal* — both argued where they appear.

---

## Current Challenges

Evidence lives in doc 01; restated only as headline:

- One email + one phone per contact; multi-value exists nowhere in practice (01 §6.2, L12–L13).
- Import silently drops extra phone/email columns; enrichment discards paid second channels
  (02 §RC-4 consequence).
- Merge cannot be type-aware (losing email → secondary) until value rows exist — RC-5 is
  blocked on this doc (02 §RC-5; 03 §2.3 [9]).
- Channel search today is presence-booleans over the single value (01 §6.11); any child-table
  design must not create a two-tier system where secondaries are invisible (G16).

---

## Enterprise Best Practices (cited)

All claims via the [`03`](03-Enterprise-Research.md) register:

- **Dual shape (child objects + flat primary cache)** — Salesforce runs ContactPoint\*
  alongside the flat `Contact` columns [41][44]; HubSpot runs primary + computed
  `hs_additional_emails` [10] (03 §3.1, §3.3).
- **Exactly-one-primary is the load-bearing invariant**; promotion is an atomic swap [10][22];
  dial/send/sync/export bind to the primary [13][25] (03 §3.3).
- **Dual phone representation**: raw-as-entered + derived E.164 [12][24][43];
  default-country inference is an import-time knob [12]; **extension lives outside the E.164
  core** (vCard `;ext=` [122]; Apideck `extension` [132]; ContactPointPhone
  `ExtensionNumber` [41]) (03 §3.3, §7).
- **Line type**: libphonenumber's 12-value offline enum ∪ Twilio's carrier-live 12 (adds the
  fixed/non-fixed VOIP split); offline US typing is inherently ambiguous
  (`FIXED_LINE_OR_MOBILE`) — so store *how it was determined* too [124][125][126] (03 §7).
- **Type model**: RFC 9553's three orthogonal axes (`features` ⊥ `contexts` ⊥ `pref`); RFC
  6350 `TYPE` + `PREF`; Merge's LCD enum HOME/WORK/MOBILE/OTHER [122][123][127] (03 §3.1–3.2).
- **Stable per-value identity is normative** — RFC 9553 map keys "MUST be preserved";
  merge/sync re-points by id, never rewrites in place [123] (03 §7).
- **The failure mode to avoid**: HubSpot secondaries invisible to segments/reports/sends —
  its top documented complaint [10][23] — the G16 guard.
- **Merge is type-aware**: losing email demotes to secondary, never discarded [9] (03 §2.3).
- **Interop degrades**: expect `[{value, type, primary}]` at sync/export boundaries;
  verification/provenance never survive flattening [127][132] (03 §3.3).

---

## Gaps

| Gap | This doc's answer |
|---|---|
| **G15** (P0) — no multi-value channels | The two child tables (§Recommended Solution), dual-written, backfilled, read-cutover behind flags (§Implementation Steps) |
| **G16** (P1 ⚑guard) — secondaries must be searchable | §Search & masking: secondaries feed dedup/match, presence flags, counts; masked view exposes counts+types+statuses, never values |
| G20 (04-owned) — true merge | Prerequisite delivered here: stable row ids + soft-delete + type-aware demotion targets (§Soft-delete; 04 §merge consumes) |
| G13 (08-owned) — merge-strategy surface | §Import touchpoints defines the multi-value conflict policy the import wizard exposes |
| G24 ◇ (12-owned) — production search adapter | §Search defines what the index must cover; the engine itself stays doc 12's concern |

---

## Recommended Solution

### 1. Two tables, one shared shape

`contact_emails` and `contact_phones` are specified as one shared column set plus per-table
deltas. Idioms are copied from `schema/contacts.ts`: `uuid_generate_v7()` ids
(`contacts.ts:29`), `citext`/`bytea` custom types (`contacts.ts:27–28`), varchar+CHECK enums
(house pattern, `contacts.ts:196–207`), tenant/workspace FK helpers (`contacts.ts:32–39`).

#### 1.1 Shared columns (both tables)

| Column | Type | Null | Default | Semantics |
|---|---|---|---|---|
| `id` | uuid PK | NOT NULL | `uuid_generate_v7()` | Stable per-value identity (RFC 9553 normative [123], 03 §7); merge re-points/tombstones by this id, never rewrites in place |
| `tenant_id` | uuid FK → `tenants(id)` ON DELETE CASCADE | NOT NULL | — | Two-tier tenancy (DM4) |
| `workspace_id` | uuid FK → `workspaces(id)` ON DELETE CASCADE | NOT NULL | — | **Denormalized onto every child row** — RLS never derives scope through the parent join (mirrors `import_job_rows`, 15 §5) |
| `contact_id` | uuid FK → `contacts(id)` ON DELETE CASCADE | NOT NULL | — | Cascade covers the hard-delete fanout (DSAR final purge); product deletion is soft (`deleted_at`), mirroring `source_imports.contact_id` (`contacts.ts:249–251`) |
| `value_enc` | bytea | NOT NULL | — | AES-GCM ciphertext via `encryptPii` (DM1). Emails: storage form (trim+lowercase, `normalizeEmailForStorage`). Phones: the cleaned as-entered value (whitespace-normalized) — the dialable/display form |
| `blind_index` | bytea | NOT NULL | — | HMAC-SHA256 via `blindIndex` (DM1) over the per-table index form. Emails: `normalizeEmailForIndex(storage)` — plus-tag stripped, byte-identical to today's `email_blind_index`. Phones: digit-compacted raw (`[\s().-]` stripped, leading `+` kept) — the exact-value key that works even when E.164 parsing fails |
| `type` | varchar(20) | NOT NULL | `'other'` | Usage context; per-table CHECK below (§1.4) |
| `is_primary` | boolean | NOT NULL | `false` | Exactly one live primary per contact per table (§2.1) |
| `status` | varchar(20) / varchar(50) | see delta | see delta | Verification verdict — the shipped vocabularies, unchanged (Reconciliation #5) |
| `confidence` | numeric(3,2) | NULL | — | Per-value confidence ∈ [0,1]; CHECK `confidence IS NULL OR confidence BETWEEN 0 AND 1`; same scale as the provenance descriptor `conf` (`fieldProvenance.ts:24–25`) |
| `source` | varchar(50) | NOT NULL | — | Platform-level source label, **same grammar as `field_provenance.src`**: `import:apollo` \| `provider:zoominfo` \| `user_edit` \| `reveal` \| `master` — never a workspace id (`fieldProvenance.ts:19–21`, DM6) |
| `source_import_id` | uuid FK → `source_imports(id)` ON DELETE SET NULL | NULL | — | Lineage pointer for import-born values (ADR-0006: `source_imports` is the only lineage); SET NULL because retention may reap `source_imports` at 730 d (`packages/types/src/retention.ts:81`) |
| `pinned` | boolean | NOT NULL | `false` | Row-grain human pin: blocks automated demotion/soft-delete/overwrite of this value (DM6 pin semantics at value grain; §3.3) |
| `first_seen_at` | timestamptz | NOT NULL | `now()` | When this value first appeared on this contact (survives re-imports — append-with-dedup never resets it) |
| `last_verified_at` | timestamptz | NULL | — | Set by a verification run grading *this value* (per-value analog of `contacts.last_verified_at`, `contacts.ts:149–153`) |
| `deleted_at` | timestamptz | NULL | — | Soft delete (§Soft-delete); tombstoned rows keep ciphertext until retention/DSAR nulls it |
| `created_at` | timestamptz | NOT NULL | `now()` | — |
| `updated_at` | timestamptz | NOT NULL | `now()` | `set_updated_at()` trigger, same function as contacts (`rls/contacts.sql:9–14`) |

#### 1.2 `contact_emails` deltas

| Column | Type | Null | Default | Semantics |
|---|---|---|---|---|
| `email_domain` | citext | NOT NULL | — | Clear, non-PII facet derived via `emailDomainOf` (DM1) — same posture as `contacts.email_domain` (`contacts.ts:122`). NOT NULL here (a value row only exists when a well-formed email exists; the flat column stays nullable because the *contact* may have no email) |
| `status` | varchar(20) | NOT NULL | `'unverified'` | CHECK mirrors `contacts_email_status_enum` exactly (`contacts.ts:196–199`) |
| `blind_index` | — | NOT NULL | — | (shared column, tightened) always derivable for a well-formed email |

#### 1.3 `contact_phones` deltas

| Column | Type | Null | Default | Semantics |
|---|---|---|---|---|
| `e164_enc` | bytea | NULL | — | Ciphertext of the derived E.164 (`toE164`, DM1). NULL exactly when the number is unparseable (§4). The canonical form dial/export/sync prefer (03 §3.3 [12][43]) |
| `e164_blind_index` | bytea | NULL | — | `blindIndex(e164)` — the *normalized* match key; NULL when unparseable. This, not the raw-digits `blind_index`, is what dedup/match signals ride (§2.2) |
| `raw_original_enc` | bytea | NULL | — | Byte-exact original as it appeared in the source (file cell / API payload) *when it differs from* `value_enc`'s cleaned form; NULL otherwise. Feeds repair-CSV/audit fidelity (03 §6.3 [58]) |
| `country_hint` | char(2) | NULL | — | ISO-3166 alpha-2 default region used (or inferred) at parse time — recorded so a re-parse is reproducible (03 §3.1 [12]) |
| `extension` | varchar(16) | NULL | — | Outside the E.164 core, always (03 §7 [122][132][41]); populated from libphonenumber's `ext` or an explicit import column |
| `line_type` | varchar(24) | NULL | — | Union taxonomy, §1.5 |
| `line_type_source` | varchar(20) | NULL | — | How determined: `carrier_lookup` (Twilio-class, authoritative) \| `libphonenumber` (offline heuristic) \| `provider` (enrichment payload) \| `import` (declared in file) — mandatory companion because offline typing is inherently ambiguous (03 §7 [125]) |
| `status` | varchar(50) | NULL | — | The shipped `phone_status` vocabulary (`types/contacts.ts:34`), nullable like `contacts.phone_status` (`contacts.ts:132`). The vocabulary conflates kind (`direct|mobile|hq`) with validity (`valid|invalid`) — kept as-is per DM1; vocabulary cleanup is a doc-04 candidate, out of scope here |

#### 1.4 The `type` enum — justification

One shared vocabulary, per-table CHECK subsets:

- `contact_emails.type` ∈ `work | personal | other`
- `contact_phones.type` ∈ `work | personal | mobile | direct | hq | other`

Rationale (03 §3.1–3.2): RFC 9553 `contexts` gives exactly `work`/`private` as the
interoperable usage axis [123]; the Merge/Apideck interop core is HOME/WORK/MOBILE/OTHER
[127][132] — so `work`/`personal`/`mobile`/`other` guarantee lossless egress to every unified
schema. `direct` and `hq` are the sales-intelligence-specific kinds TruePoint already grades
via `phone_status` (`direct|mobile|hq`, `types/contacts.ts:34`) and every SI dataset ships —
they are *usage* labels (a direct dial vs a switchboard), orthogonal to `line_type`
(the carrier's classification). `type` answers "what is this value for", `line_type` answers
"what kind of line is it", `status` answers "is it any good" — the three RFC 9553 axes
(contexts ⊥ features ⊥ pref) mapped onto columns, with `is_primary` as the degenerate
two-level `pref` (a full 1–100 ranking was considered and rejected: no consumer needs more
than primary-first + insertion order, and rankings invite unmaintained drift).

#### 1.5 `line_type` — the union taxonomy

Extends the shipped `phoneLineType` zod enum **additively** (DM1: one vocabulary, widened in
place — `types/contacts.ts:39` remains the single symbol of record; the flat
`contacts.phone_line_type` column shares it):

`mobile | landline | fixed_voip | non_fixed_voip | voip | toll_free | premium_rate |
shared_cost | personal | pager | uan | voicemail | fixed_line_or_mobile | unknown`

- Kept from shipped: `mobile`, `landline`, `voip`, `unknown` (backwards-compatible).
- From Twilio Lookup (carrier-live, 03 §3.1 [124]): the `fixed_voip`/`non_fixed_voip` split
  (fraud/TCPA-relevant), `toll_free`, `premium_rate`, `shared_cost`, `uan`, `voicemail`,
  `pager`, `personal`.
- From libphonenumber (offline, 03 §3.1 [125][126]): `fixed_line_or_mobile` — the honest US
  ambiguity value; storing it (rather than guessing) is the point of `line_type_source`.
- `voip` remains for legacy rows and providers that don't distinguish fixed/non-fixed.

### 2. Constraints & indexes

#### 2.1 Exactly-one-primary (both tables)

```sql
CREATE UNIQUE INDEX uniq_contact_emails_primary ON contact_emails (contact_id)
  WHERE is_primary AND deleted_at IS NULL;
-- identical shape for contact_phones
```

The partial unique enforces **at most one** live primary per contact; "exactly one whenever
any live row exists" is the app-level invariant maintained by the single write path (§3.1)
and checked by the reconciliation job (§3.4). Promotion is an **atomic swap** in one
`withTenantTx` — demote the old primary, promote the new one, rewrite the flat cache — the
HubSpot "Make primary" mechanic (03 §3.3 [10][22]). Order matters under a non-deferrable
partial unique: demote first, then promote, same transaction.

#### 2.2 Value dedup — asymmetric by design, and the collision policy

- **Emails — per-workspace unique across contacts** (extends the shipped identity guarantee
  `uniq_contacts_ws_email` from "one primary email per workspace" to "one email *value* per
  workspace, wherever it sits"):

  ```sql
  CREATE UNIQUE INDEX uniq_contact_emails_ws_value ON contact_emails (workspace_id, blind_index)
    WHERE deleted_at IS NULL;
  CREATE UNIQUE INDEX uniq_contact_emails_contact_value ON contact_emails (contact_id, blind_index)
    WHERE deleted_at IS NULL;  -- per-contact dedup + the contact-leading FK/fetch index
  ```

- **Phones — per-contact unique only; workspace-level collision is a signal, not a
  constraint:**

  ```sql
  CREATE UNIQUE INDEX uniq_contact_phones_contact_value ON contact_phones (contact_id, blind_index)
    WHERE deleted_at IS NULL;
  CREATE INDEX idx_contact_phones_ws_e164 ON contact_phones (workspace_id, e164_blind_index)
    WHERE e164_blind_index IS NOT NULL AND deleted_at IS NULL;  -- non-unique match-signal lookup
  ```

  This deviates deliberately from the shared-shape shorthand (per-workspace unique on both
  tables), and the reason is a hard product fact: an HQ/switchboard number legitimately
  appears on *many* contacts at the same company — a workspace-wide phone unique would reject
  perfectly normal imports wholesale. The market agrees: email and domain are dedup keys everywhere;
  phone is a dedup key **nowhere** (03 §2.1 [8][81][87]); phone appears only as a *match*
  rung (`deterministic_phone` — already defined in the shipped ladder vocabulary,
  `matchKeys.ts:23–28`). So a shared phone is representable, while a cross-contact E.164 hit
  still surfaces — as a duplicate *signal*.

- **Collision policy (feeds 04's dedup ladder).** When an import/enrichment write brings a
  value that already lives on **another** contact in the workspace:
  - *Email:* this is an identity-key hit — the row **resolves to that contact** through the
    dedup ladder before any insert is attempted (`findByDedupKeys` precedence,
    `contactRepository.ts:343–389`); the child insert then lands on the matched contact and
    dedups per-contact. If a row matched contact A via LinkedIn but carries an email owned by
    contact B, the email child row is **not inserted** on A; instead a duplicate signal
    (A↔B, key=email) is recorded for the review queue (G21; 03 §2.3 [34] Duplicate Record
    Sets pattern) and the import row completes with a warning. The unique index is the last
    line of defence against races, not the control flow: writes batch-check first and use
    `ON CONFLICT DO NOTHING` + post-verify, so a violation is never surfaced to the user as
    an error (03 §2.3: bulk paths never row-block on duplicates [34]).
  - *Phone:* the non-unique `idx_contact_phones_ws_e164` lookup produces the same A↔B signal
    (weaker rung), and the value **is** still inserted (shared lines are legal).

#### 2.3 Fetch & facet indexes

```sql
CREATE INDEX idx_contact_emails_ws_contact ON contact_emails (workspace_id, contact_id);
CREATE INDEX idx_contact_phones_ws_contact ON contact_phones (workspace_id, contact_id);
CREATE INDEX idx_contact_emails_ws_domain  ON contact_emails (workspace_id, email_domain)
  WHERE deleted_at IS NULL;  -- the any-value domain facet (G16)
```

`(workspace_id, contact_id)` keeps the per-contact channel fetch index-backed *under the RLS
workspace predicate* (the house rationale stated on the shipped workspace-composite indexes,
e.g. `contacts.ts:219, 225–227`). The contact-leading uniques in §2.2 serve the FK cascade path
(`DELETE FROM contacts` fanout scans by bare `contact_id`).

Six indexes per table is the budget ceiling; nothing else is added until a measured read
justifies it (doc 12 owns the envelope).

#### 2.4 RLS — identical in form to contacts

Quoted against `packages/db/src/rls/contacts.sql:28–33`, the policy each table gets,
verbatim in shape:

```sql
ALTER TABLE contact_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_emails FORCE ROW LEVEL SECURITY;
CREATE POLICY contact_emails_workspace_isolation ON contact_emails
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON contact_emails TO leadwolf_app;
-- identical block for contact_phones
```

Fail-closed: `NULLIF(..., '')` treats unset and reset GUCs as no-scope, so an unscoped query
reads nothing (`rls/contacts.sql:3–5`). Scope is **direct** on the denormalized
`workspace_id`, never derived through the `contacts` join — the child of a visible parent is
not automatically visible; it carries its own wall (the `import_job_rows` precedent, 01 §5.1).
No user GUC exists or is added (DM4; 02 §RC-1 mechanism).

### 3. The primary-cache synchronization contract (the load-bearing invariant)

**Invariant CH-INV-1:** for every live contact, the flat columns
(`email_enc`, `email_blind_index`, `email_domain`, `email_status`) are a byte-exact
projection of the single live `is_primary` `contact_emails` row — or all-NULL (with
`email_status` at its `'unverified'` default) when no live email row exists. Symmetrically
`phone_enc`/`phone_status`/`phone_line_type` ← the primary `contact_phones` row. The blind
index equality is the checkable form: `contacts.email_blind_index = primary_child.blind_index`.

#### 3.1 The single write path

One service function per channel — working name `applyChannelWrite(tx, contactId, op)` in
`packages/core` — is the **only** code allowed to mutate child rows *or* the flat channel
columns once dual-write is on. Every op (add, promote, demote, soft-delete, verify-update,
pin) runs child-row change + flat-cache rewrite **in the same `withTenantTx`** — never two
transactions, never fire-and-forget. Callers (import merge, enrichment, reveal, user edit,
merge executor, verification) compose ops; they never touch the columns directly. This is
the same "one canonical implementation" discipline DM1 applies to normalizers, applied to a
write path — and it is what makes CH-INV-1 provable rather than hoped-for.

#### 3.2 DM6 division of labour — winner-map governs the cache; rows carry value provenance

Two provenance grains coexist, each owning what it is good at:

- **`field_provenance` (the winner-map) governs the flat cache slot.** The map gains `email`
  and `phone` keys (fulfilling the deferral noted at `fieldProvenance.ts:50–53`). The
  descriptor describes *the value currently holding the primary slot*: `src`, `conf`, `obs`,
  `ver`, and — decisive — `pin`. When any writer proposes a **different primary**, the
  decision runs through the shipped pin-aware `planFieldWrite` exactly as scalar fields do
  (15 §1 fact 2): a pinned primary is never displaced by automation. `pin=true` on the
  winner-map entry and `pinned=true` on the corresponding child row are written together by
  the same op (one source of truth for "may automation displace the primary" — the
  winner-map; the row flag is its per-value shadow so row-grain queries don't parse jsonb).
- **Child rows carry per-value provenance** (`source`, `source_import_id`, `confidence`,
  `first_seen_at`, `last_verified_at`, `pinned`) — facts about each value that the winner-map
  structurally cannot hold (it keeps only the winning descriptor per field,
  `fieldProvenance.ts:2–3`).

Net effect: **appending a secondary never consults the winner-map** (no cache change);
**changing the primary always does**.

#### 3.3 Who may flip primary

| Trigger | Mechanism | Guard |
|---|---|---|
| User "Make primary" | Atomic swap op (§2.1) | Org-role member+; audited |
| Merge (04's contract) | Survivor keeps its primary; loser's primary is re-pointed as survivor secondary (type-aware demotion, 03 §2.3 [9]) | Doc 04 §merge owns sequencing; operates via `applyChannelWrite` ops only |
| Verification demotion | Primary email graded `invalid` (hard bounce): policy may auto-promote the best remaining `valid` value (status > confidence > first_seen_at tiebreak) | Flag-gated (default **off**), skipped when winner-map `pin=true`, audit event `channel_primary_demoted`; mirrors bounce-aware primaries (03 §3.1 [42]) |
| Import | **Never flips an existing primary.** A no-email contact gaining its first email: that value becomes primary (cache fill via `planFieldWrite`, as today) | Explicit per-import "set primary from column X" mode is the only exception — still pin-checked |

#### 3.4 Drift detection

A scheduled reconciliation sweep (leader-locked, per-workspace keyset batches — the
`backfillMaster` walking idiom) recomputes CH-INV-1 by comparing blind indexes and status
columns. Output: a drift metric (target 0 after burn-in), audit rows for repairs. Repair
direction is phase-dependent and explicit: **flat wins** while flat is still the source of
truth (S-CH2/S-CH3), **child wins** after read cutover (S-CH4). The job never guesses.

### 4. The E.164 normalization pipeline

1. **Write time, every path** (import, enrichment, user edit, API): `normalizeText` → `toE164
   (value, countryHint)` (`matchKeys.ts:87–95` — DM1, the shipped primitive; no second
   parser). Parseable: `e164_enc = encryptPii(e164)`, `e164_blind_index = blindIndex(e164)`,
   `extension` from the parser's `ext` output; `value_enc` keeps the cleaned as-entered form
   (dual representation, 03 §3.3 [12][43]).
2. **Default-country inference at import** (03 §3.1 [12]): resolution order for
   `countryHint` = per-import wizard option (doc 08/11) → workspace default setting → the
   row's `locationCountry` (mapped column) → none (only `+`-prefixed international numbers
   parse). The hint actually used is recorded on the row (`country_hint`) so re-parses are
   reproducible.
3. **Unparseable numbers are kept, flagged, never fatal**: row inserts with `e164_enc`/
   `e164_blind_index`/`line_type` NULL and the raw preserved in `value_enc`; the import row
   completes with a warning code (`phone_unparseable` in the reject-histogram *warning* band,
   not a rejection — 08's artifact contract); the value is invisible to E.164 match signals
   but still exact-match dedupable per-contact via the raw-digits `blind_index`. A later
   verification or user edit that supplies a country can upgrade the row in place.
4. **Blind-index discipline:** match/dedup signals ride `e164_blind_index` exclusively —
   never the raw-digits key (raw formats vary per typist; E.164 is the canonical key,
   03 §7 [125]).

### 5. Search, masking, and consumption (G16)

- **Search projection:** `has_email`/`has_phone` become "∃ live child row" (not "flat column
  non-null" — identical during steady state by CH-INV-1, but correct for no-primary edge
  states); new countable facets `email_count`/`phone_count`; the domain facet matches **any**
  live email's `email_domain` (index §2.3), and type/status/line_type facets aggregate across
  values. Dedup/match reads secondaries (§6). This is precisely the leapfrog 03 §3.3 names:
  any-value search is HubSpot's top documented gap [10][23]. The production engine remains
  doc 12/G24 ◇; the in-memory `SearchPort` adapter gains the same fields so behavior is
  engine-independent (01 §6.11).
- **`maskedContactSchema` extension (additive, never weakening):** keeps every current field
  (`types/contacts.ts:374–411` — `emailDomain` = the *primary's* domain, `emailStatus`/
  `phoneStatus`/`phoneLineType` = the primary's grades, so no consumer breaks), and adds:

  ```
  emailCount: number, phoneCount: number,            // live child rows
  emailSummaries?: [{ type, status, isPrimary }],     // per-value, NON-PII —
  phoneSummaries?: [{ type, status, lineType, isPrimary }]  // never values, never secondary domains
  ```

  Optional-populated like `dataHealth`/`revealedTypes` (only surfaces that compute them).
  **Secondary values and secondary email domains are PII-adjacent and stay masked until
  reveal** — the payload names counts, types, statuses only.
- **Reveal grain:** unchanged — `contact_reveals` claims stay per contact × `reveal_type`;
  an `email` claim unmasks **all** live email values of that contact. Per-value metering is a
  product/billing decision explicitly deferred (doc 04/billing note): the claim ledger, the
  reveal CHECK invariants (`contacts.ts:212–217`), and the credit model are all
  contact-grained.
- **Dialing / export / CRM-sync pick primary-first** (03 §3.1 [13][25]): the dialer defaults
  to the primary with a per-call picker over live phones (line_type-badged for TCPA risk —
  the shipped `phoneLineType` signal, `contacts.ts:133–136`); export flattens to the primary
  column + a semicolon-joined "additional" column [10]; CRM-sync degrades to
  `[{value, type, primary}]` and never expects verification/provenance to survive [127][132].

### 6. Import & dedup touchpoints

- **`findByDedupKeys` / `findByDedupKeysBatch` extend to secondary blind-indexes.** The email
  rung's lookup target changes from `contacts.email_blind_index` to
  `contact_emails.blind_index` (workspace-scoped; the partial unique §2.2 guarantees ≤1 live
  row per key → resolve `contact_id`). The batch shape is preserved exactly — collect keys
  across the chunk, ≤3 workspace-scoped IN-list SELECTs, resolve by precedence in app
  (`contactRepository.ts:391–465`; 15 §2 chunk merge) — only the email SELECT's table
  changes, and it stays one query per chunk. During dual-write (pre-cutover) the lookup
  UNIONs flat + child to see pre-backfill rows; after S-CH4 it reads child only. Ladder
  precedence (email → linkedin → sales-nav) is untouched; how E.164 participates was doc 04's
  call and **04 §2 has made it**: a match *signal* feeding `duplicate_of_contact_id` markers,
  never a deterministic upsert rung (the vocabulary already exists, `matchKeys.ts:23–28`) —
  this doc only guarantees the index (§2.2) that makes the probe O(1).
- **COPY-staging compatibility (the 15 §1 ciphertext rule).** Multi-value cells are prepared
  *before* staging: the `prepareContact` extension emits, per row, a `channels` structure —
  each entry already carrying `{ table, type, value_enc, blind_index, e164_enc?,
  e164_blind_index?, extension?, country_hint? }` with ciphertext/blind-index bytes computed.
  Staged as one jsonb column (bytes hex-encoded inside the json — COPY-safe as quoted text,
  sidestepping the bytea-in-CSV encoding for the variable-cardinality part; the flat primary
  columns keep their existing bytea staging encoding). The chunk merge inserts child rows
  batched (`insertBatch` sibling) in the same chunk `withTenantTx`. No channel value —
  primary or secondary — ever reaches staging as plaintext (the 15 §1 ciphertext rule);
  `staging.raw_data` remains the **one** documented transient-plaintext column (the raw source
  row kept for `source_imports` provenance, REVOKE'd + dropped on finalize — 15 §8;
  `importStagingRepository.ts:6–8`), and the `channels` structure adds no second one.
- **Column mapping:** the wizard maps multiple source columns onto typed channel slots
  (`phone` → type `work`/primary-candidate, `mobile_phone` → `mobile`, `hq_phone` → `hq`,
  `secondary_email` → `personal`, …) — doc 08 owns the mapping UX; this doc fixes the target
  shape.
- **Conflict policy for multi-value columns — recommended: append-with-dedup + explicit
  primary control.** On a matched contact: every incoming value not already on the contact
  (per-contact `blind_index`) is **appended as a secondary**; values already present update
  only empty enrichable fields (extension, line_type) and bump nothing else; the primary is
  never flipped (§3.3). `replace` semantics are **not offered** in v1 — destructive, no
  market precedent for values (HubSpot's per-property "prevent overwrite" is the closest
  ethos, 03 §2.1 [1]; type-aware merge demotes rather than discards [9]). The existing
  scalar `conflictPolicy` (skip/update) continues to govern scalar fields; channels get the
  orthogonal append behavior — losing data by import becomes structurally impossible, which
  is the G15 headline win.

### 7. Soft-delete & history

- `deleted_at` semantics: soft-deleted rows are invisible to every product read (all partial
  indexes and queries carry `deleted_at IS NULL`), still physically present for
  support/DSAR/audit until reaped. Deleting the primary requires promoting another value
  first (or leaves the contact channel-less — legal, §Edge cases); the swap and the delete
  are one op.
- **History = soft-deleted rows + audit entries.** A demoted or removed email remains a
  tombstoned row (with its provenance intact) — that *is* the channel history; field-level
  before/after history for scalars remains G22 ◇ (not solved here, 02 §G22). Every op writes
  an `audit_log` action (append-only ledger, 01 §6.10); action-enum additions
  (`channel_added`/`channel_promoted`/`channel_deleted`/`channel_primary_demoted`) are
  spec'd with doc 04's audit section (cross-ref 04 §history).
- **Retention:** two new data classes `contact_emails`/`contact_phones` registered in the
  retention engine, seeded to mirror `contacts` — `ttlDays: null`, `mode: 'shadow'`
  (`packages/types/src/retention.ts:83` posture; engine per
  [`../data-management/16-retention-engine-design.md`](../data-management/16-retention-engine-design.md)).
  DSAR/tombstone PII-nulling fanout (`deleteFanout`) extends to null `value_enc`/`e164_enc`/
  `raw_original_enc` on the children whenever it nulls the parent contact's PII — deletion is
  real (truepoint-data core principle), and the blind indexes are nulled with the ciphertext
  (a keyed HMAC of PII is still personal data under the deletion obligation).

---

## Implementation Steps (migration summary — step IDs, no fixed numbers)

Full sequencing, test gates, and rollback drills live in doc `15`. Series rule: step IDs
only; migration numbers are taken at PR time (README §Conventions).

| Step | What ships | Flag / lever | Reversible? |
|---|---|---|---|
| **S-CH1** | DDL expand: both tables, indexes (§2), RLS + grants + `set_updated_at` triggers, retention-class seed rows. Pure additive; zero readers/writers | none needed (dead schema) | DROP (down migration) |
| **S-CH2** | Dual-write: `applyChannelWrite` becomes the write path; child rows written alongside byte-identical flat writes. Flat remains source of truth | `CHANNEL_DUAL_WRITE` env kill-switch (explicit-`"true"`, house posture 01 §7.3) | flag off ⇒ shipped write path, byte-identical |
| **S-CH3** | Backfill job: keyset-walk live contacts per workspace; contacts with flat email/phone and no child rows get `is_primary = true` rows — **email ciphertext + blind index copied verbatim, no re-encrypt, no re-normalize** (DM1: same bytes ⇒ CH-INV-1 holds by construction). Phones additionally decrypt → `toE164` (hint from `locationCountry`, else raw-only) → populate `e164_*` in-worker. Idempotent (`ON CONFLICT DO NOTHING` on the §2.2 uniques), re-runnable, bounded batches | job-level flag + per-workspace batch control | re-runnable; no destructive writes |
| **S-CH4** | Read cutover: dedup lookups (§6), reveal reads, exports, search projection resolve from child tables; flat becomes pure cache; reconciliation repair direction flips child→flat (§3.4) | `CHANNEL_READ_FROM_CHILD` env flag | flag off ⇒ reads return to flat (still dual-write-maintained); secondaries invisible again, nothing lost |
| **S-CH5** | Permanent reconciliation sweep + drift metric/alert wired (§3.4) | scheduled job enable | job off |

> **Ordering refinement vs the program-brief shorthand** (which listed backfill before
> dual-write): dual-write **must precede** the backfill sweep, or every contact written
> between backfill-end and dual-write-on lacks child rows. Order here: S-CH2 on → S-CH3 run
> (and re-run to close any tail) → verify zero drift → S-CH4. Standard expand → dual-write →
> backfill → cutover discipline; doc 15 encodes the gate between each.

---

## UI/UX

Owned by doc 11 / the contact-detail surface (doc 04); this doc fixes only the contracts the
UI consumes: masked summaries (§5), the atomic "Make primary" verb, the per-call phone picker
with line-type badges, four-state channel lists (`StateSwitch`, `@leadwolf/ui`). One UX rule
is normative here because it protects an invariant: primary changes are always an explicit
promote action on a named value — never a side effect of editing a value in place [123].

---

## DB & Backend — pre-build reasoning pass (explicit answers)

Per `truepoint-architecture/references/pre-build-thinking.md`, answered for this design:

- **Source of truth.** Child tables own channel values (post-S-CH4); the flat columns are a
  named, denormalized cache with a written invariant (CH-INV-1) and a single writer
  (§3.1). During S-CH2/S-CH3 the flat columns are still authoritative — the phase boundary
  is explicit, flag-carried, and the reconciliation job's repair direction encodes it.
  Conflicts: winner-map + pin decide the cache slot (DM6); per-value facts live on rows.
- **Failure modes.** (a) *Cache drift* — a write path bypassing `applyChannelWrite`: guarded
  by code review + the single-module rule, detected by the S-CH5 sweep (metric + alert),
  repaired directionally. (b) *Partial backfill* — S-CH3 interrupted: idempotent and
  re-runnable; the drift sweep counts contacts with flat values but no child rows, so
  incompleteness is measurable, and S-CH4 is gated on that count reaching zero. (c) *Failed
  promote swap* — single tx: all-or-nothing, no half-swapped state. (d) *Unparseable phones*
  — kept raw, flagged, never a row rejection (§4). (e) *Verifier down* — rows stay
  `unverified`/NULL status; nothing blocks.
- **Duplicate prevention.** Per-contact partial uniques on `(contact_id, blind_index)` both
  tables; per-workspace unique for emails; import writes batch-check then
  `ON CONFLICT DO NOTHING`; idempotency at the API via `Idempotency-Key` (house contract);
  re-imports dedup on the same blind indexes so `first_seen_at` survives.
- **Audit.** Every op writes `audit_log` (actor, action, contact id, channel-row id — never
  the value); same tx as the mutation (not fire-and-forget). Support can reconstruct channel
  history from tombstones + audit alone (§7).
- **Security.** FORCE RLS with the fail-closed GUC idiom on both tables (§2.4); values
  AES-GCM encrypted, blind-indexed via the keyed HMAC (both keys server-side,
  KMS-target per `encryptPii.ts:9–10`); masked until reveal — the API never returns values
  without a reveal claim; no channel value, plaintext or ciphertext, is ever logged; writes
  are org-role gated (member+) and IDs client-supplied are validated against the RLS-scoped
  row, never trusted (threat checklist items 1–3, 8).
- **Scalability (10x).** 10x ≈ 30–50 M rows per child table (10–20 M contacts × ~1.2 emails /
  ~1.5 phones). Row width ≈ 300–500 B (two-three bytea values dominate) ⇒ ~15–25 GB/table —
  well inside a plain-table envelope; **no partitioning** (contrast `import_job_rows`, which
  is unbounded-per-import; channels are bounded by contact count × small factor). Every read
  is either per-contact (`(workspace_id, contact_id)`) or per-key (blind-index partial
  uniques) — no scans, no N+1 (per-contact channel fetch batches by `inArray(contact_id)`
  for list surfaces). `uuid_generate_v7` keeps inserts append-ordered (low index churn).
  Backfill is the one bulk writer: keyset batches, bounded tx sizes, off-peak runnable.
  Index budget: 6/table (§2.3) — insert amplification accepted, measured before any additions.
- **Monitoring.** Drift metric (S-CH5), backfill progress counters, `phone_unparseable`
  warning rate per import, dedup-signal volume (feeds G21 queue sizing), promote-swap error
  rate. Runbook entry: "drift alert → check flag phase → run reconciliation in repair mode."
- **Rollback.** Every step flag-carried (table above); S-CH1 is droppable; post-S-CH4
  rollback loses no data (dual-write keeps the cache warm) — secondaries merely go invisible
  until re-cutover.
- **Edge cases.** See §Edge Cases below.
- **Assumptions (load-bearing, written down).** (1) `BLIND_INDEX_KEY` is stable — already the
  system-wide assumption (`blindIndex.ts:2–4`); child tables add no new rotation exposure but
  double the reindex surface if it ever rotates. (2) Reveal stays contact×channel-grained
  (§5). (3) Email remains a workspace-unique identity key — if a future product decision
  allows shared emails (it shouldn't), §2.2 must be revisited.
- **Misuse / limits.** Per-contact channel caps enforced at the API edge: 25 emails / 25
  phones per contact (generous × any legitimate dataset; blocks a hostile 10⁶-row fanout on
  one contact). Import rows exceeding the cap append up to the cap and warn.
- **Worst case.** A bug in `applyChannelWrite` silently writes wrong primaries workspace-wide
  → wrong values dialed/exported. Detectable *before* damage compounds: the drift sweep
  compares independent representations (flat vs child) — a systematic writer bug shows as an
  immediate drift spike; the alert fires, `CHANNEL_READ_FROM_CHILD` flips off (reads return
  to the flat cache), repair runs. Recoverable: yes, by construction of the dual shape.

---

## API

Owned in detail by doc 04's contact API section; the channel verbs this doc requires (all
`/api/v1`, RFC 9457 errors, `Idempotency-Key` on writes, shared Zod in `@leadwolf/types` —
`contactEmailSchema`/`contactPhoneSchema` masked/revealed variants):

| Verb | Route | Notes |
|---|---|---|
| List (masked) | in `GET /contacts/:id` payload | summaries per §5; values only with a reveal claim |
| Add | `POST /contacts/:id/emails` · `POST /contacts/:id/phones` | body: value, type (+ phones: countryHint?, extension?); 201 with masked row; per-contact cap 25 |
| Edit metadata | `PATCH .../:valueId` | type, pinned; **never the value in place** — replace = add + delete (stable ids, [123]) |
| Make primary | `POST .../:valueId/make-primary` | the atomic swap (§2.1); 409 on soft-deleted target |
| Remove | `DELETE .../:valueId` | soft delete; primary requires prior/simultaneous promote |

All routes: `authn` → `tenancy` → `requireRole` member+ for writes, viewer for reads —
workspace-wide visibility per the shipped ownership posture (01 §6.4); rate-limited like
sibling contact writes.

---

## Edge Cases

- **No-primary contact** — legal (a contact may have no email/phone at all): flat cache
  all-NULL, `has_* = false`, counts 0. A contact with live rows but no primary is **drift**
  (CH-INV-1 violation) — auto-repaired by promoting best-status/oldest, audited.
- **All values deleted** — deleting the last live row nulls the flat cache in the same tx
  (email_status resets to `'unverified'`); dedup keys release (partial uniques exclude
  tombstones) so the value can be legitimately claimed by another contact later.
- **Same value typed differently** — `+1 (415) 555-2671` vs `14155552671`: different raw
  `blind_index`, same `e164_blind_index` → per-contact E.164 dedup collapses them at write
  (append-with-dedup checks both keys); cross-contact it is the §2.2 match signal.
  Email `Jane+crm@X` vs `jane@X`: same index-form blind index (plus-strip,
  `normalize.ts:22–30`) → one row; the storage form first seen wins `value_enc`.
- **Two concurrent make-primary swaps** — second tx blocks on the row lock then re-validates;
  the partial unique makes a double-primary unrepresentable; loser gets a clean 409 replay.
- **Concurrent import + user delete** — import's batch-check saw the row live, insert hits
  `ON CONFLICT` with the tombstoned row *excluded* from the partial index → insert succeeds
  as a new row; acceptable (the user deleted the old value; the import legitimately
  re-asserts it with fresh provenance).
- **Unknown enum values from providers** — line types outside the union map to `unknown` +
  `line_type_source` kept; never rejected (future-proof default case).
- **Blind-index collision across tenants** — unobservable: all lookups are workspace-scoped
  under RLS; the HMAC is globally deterministic but never queried globally. **XLSX
  multi-column mapping at scale** — inherits doc 08's XLSX ceiling (03 §6.3 [144]).

---

## Testing

- **RLS isolation itest** per table (cross-workspace read = 0 rows; unset GUC = 0 rows) —
  mirrors the shipped importJobs RLS itest (01 §5.1 family).
- **Invariant property test:** after any sequence of `applyChannelWrite` ops, CH-INV-1 holds
  (flat == primary row byte-compare on blind index + status).
- **Swap race test:** two concurrent make-primary → exactly one primary, one 409.
- **Dual-write parity test:** `CHANNEL_DUAL_WRITE=false` ⇒ write path byte-identical to
  shipped behavior (the 15 §8 parity-test discipline, extended).
- **Backfill idempotency test:** run twice ⇒ identical state; interrupt mid-batch + rerun ⇒
  identical state; email bytes verbatim-copied (no re-encryption — assert ciphertext
  equality).
- **E.164 pipeline tests:** determinism of `blindIndex(toE164(...))`; unparseable-kept-raw;
  country-hint resolution order; extension extraction.
- **Collision-policy test:** import row matching contact A but carrying contact B's email ⇒
  no child insert on A, duplicate signal recorded, row completes with warning.
- **Dedup-extension test:** `findByDedupKeysBatch` resolves a contact by a *secondary* email.
  **Masked-contract test:** the extended `maskedContactSchema` never leaks a value or a
  secondary domain (extends `packages/types/src/contacts.test.ts` guards).
- All flagged for CI — this sandbox cannot run `bun test` (series mandate).

---

## Rollout

Flag phases per §Implementation Steps; each gate in doc 15 requires: parity test green →
S-CH2 on in staging → backfill on a copy workspace → drift = 0 → S-CH4 canary per-tenant
(the `feature_flags` dual-gate pattern, 01 §7.3, if per-tenant canarying is wanted) →
global. Enrichment/verification writers migrate onto `applyChannelWrite` during S-CH2 (they
gain multi-value *storage* immediately; multi-value *behavior* lands with S-CH4 reads).

---

## Success Metrics

- **Drift = 0** on the S-CH5 sweep after burn-in (the invariant holds in production).
- **Zero values dropped by import**: multi-column phone/email imports preserve 100% of
  parseable values (measured: values-in vs child-rows-created per import).
- **Secondary-hit dedup rate** > 0: duplicates caught via secondary emails that today would
  create a second contact (G15/G16 payoff, measurable from dedup-signal logs).
- **Backfill completeness**: contacts with flat values but no child rows = 0 before S-CH4.
- **No isolation regressions**: RLS itests + the security review find no cross-workspace or
  pre-reveal value exposure.
- Merge executor (04/G20) unblocked: type-aware demotion lands on these rows.
