# 04 — Provenance (design)

> **Gate:** PLAN (design). Cites `00-overview.md` DM6 and `01-research-brief.md §2.3/§3.4`.
> **Posture: mostly reuse** — field provenance is designed (`prospect-company-data` PLAN_03) and the
> scalar slice is shipped. Net-new is the **channel provenance** seam and the **lawful-basis →
> compliance** linkage. **No code changes in this gate.**

## 1. Reuse map (cite — do not re-derive)

| Already designed / built | Where |
|---|---|
| One JSONB `field_provenance` winner-map per row (overlay + master) | `prospect-company-data` PLAN_03; cols `db/src/schema/contacts.ts:73,167` |
| Descriptor `{src,mth,conf,obs,ver,pin,by,at}`; `src` is platform-level, never a workspace id | `@leadwolf/types fieldProvenance.ts:19-37` |
| Write/merge + `pin` (human override blocks overwrite); user-edit always wins | `@leadwolf/core prospect/fieldProvenance.ts:40-80` |
| Scalar fields the pin protects (firstName…locationCity) | `fieldProvenance.ts:51-59` |
| Per-import provenance (`source_imports.raw_data`), provider cost (`provider_calls`) | `db/src/schema/contacts.ts:236-272`, `intel.ts:87-114` |
| Layer-0 immutable evidence + lineage (`source_records`, `match_links`) | ADR-0021; `03-database-design.md §5.1`; ADR-0003 (the revived raw→provenance→golden) |
| Substrate decision: JSONB winner-map (not a normalized side table) | `prospect-company-data` BRAINSTORM_03 (Substrate C); PLAN_03 |

**Conclusion:** the "JSONB vs normalized table" question is **decided** (JSONB winner-map). The
scalar slice is shipped. Two seams remain reserved-not-built.

## 2. Net-new (design here)

### 2.1 Channel provenance (`revealed_channels`, Phase 4)

PLAN_03 deferred **email/phone channel provenance** out of the scalar slice
(`fieldProvenance.ts:48-49`). Design the `revealed_channels` projection (referenced by `03 §2.4` and
PLAN_04) as the home for per-channel `{status, verification_source, last_verified_at, confidence,
source}`. Why separate from the scalar JSONB: channels are PII (encrypted, masked-until-reveal),
have their own verification lifecycle, and are copied-on-reveal into the workspace — distinct from the
non-PII scalar profile fields. The seam is reserved now; the build is Phase 4 (DM6).

### 2.2 Lawful-basis → compliance linkage (the GDPR/DPDP "source of data" enabler)

The descriptor carries `src` (platform-level source label) but **not** the legal lawful basis. The
**lawful basis lives at Layer 0** in `source_records.lawful_basis_snapshot` (per-source evidence) and,
at the subject level, in `consent_records` (`08 §2`, per subject × jurisdiction). Net-new: define the
**read path** that `05-compliance.md` uses to answer the GDPR **Art.14(2)(f)** / DPDP **source-notice**
duty for a given record — i.e. "which source asserted this field, and under what basis" =
`field_provenance.src` (which source) + `source_records.lawful_basis_snapshot` (under what basis) +
`consent_records` (subject-level basis/withdrawal). This doc owns the *provenance* half (which source
+ when); `05` owns the *notice* obligation built on it.

### 2.3 Provenance is the sync source-of-truth substrate

`07-sync.md` reuses `field_provenance.pin` + `src` + `conf` as the **field-level source-of-truth**
signal for CRM conflict resolution (never overwrite a `pin`ned/human-edited field; resolve enrichment
vs CRM by `src` priority + `conf`). Net-new here: ratify that `field_provenance` is the **single**
per-field ownership/confidence substrate sync consumes — sync must **not** add a parallel provenance
mechanism (DM1/DM6).

## 3. Target schema

| Table | Add | Rule |
|---|---|---|
| `contacts`/`accounts` | `field_provenance` JSONB | **already shipped** (`:73,167`) — reuse |
| `revealed_channels` (Phase 4) | `channel_type`, `status`, `verification_source`, `last_verified_at`, `confidence`, `source` | per-channel PII provenance; seam reserved now |
| `source_records` (Layer 0) | `lawful_basis_snapshot` | **already designed** (ADR-0021) — the legal-basis home |

No change to the JSONB descriptor shape (validated at the app edge by the Zod schema, `fieldProvenance.ts`).

## 4. RLS / scoping implications

`field_provenance` is "just another column on an already-RLS-scoped overlay table" — it adds **no** new
RLS surface (`prospect-company-data` PLAN_00 §6.1). `revealed_channels` is overlay-scoped (FORCE-RLS,
workspace GUC, DM4). `source_records.lawful_basis_snapshot` is Layer-0 (system-owned, access-path
isolation; reached only via privileged DSAR/compliance paths, not `leadwolf_app`).

## 5. Scale-gate analysis

| Breaks first | Why | Fix |
|---|---|---|
| `field_provenance` JSONB size | billions of golden rows × ~15 fields | **already mitigated:** short keys + winner-only map → inline/small-TOAST (PLAN_03 S1) |
| `revealed_channels` row count | per-channel rows at reveal scale | overlay-scoped, bounded by what a workspace revealed (not catalogue size); index on `(workspace_id, contact_id, channel_type)` |
| Provenance read for Art.14 notice | per-record source lookup at notice time | the read is a single-row JSONB read + a Layer-0 `source_records` lookup by resolved identity — O(1) per subject |

## 6. Failure modes

- **F1 — provenance retrofit becomes a destructive backfill:** prevented by reserving the seam at
  schema freeze (PLAN_00 C6/F5); `revealed_channels` is additive.
- **F2 — `src` leaks a contributing workspace id:** forbidden by the schema contract
  (`fieldProvenance.ts:20`, "NEVER a workspace id", C2) — co-op confidentiality.
- **F3 — sync adds a parallel provenance store:** prevented by §2.3 / DM1.

## 7. Open questions

1. **`revealed_channels` exact shape** — finalized in Phase 4 (PLAN_04); this doc reserves the seam.
2. **Confidence constants** in the descriptor (`conf`) remain deferred to calibration (PLAN_03 NQ1 /
   `22 §5-6`).
3. Whether DSAR "access" report renders `field_provenance` to the data subject verbatim or summarized
   — owner: compliance (`05`).
