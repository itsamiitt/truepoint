# 05 — Compliance (design)

> **Gate:** PLAN (design). Cites `00-overview.md` DM7 and `01-research-brief.md §5.1/§5.3/§5.4`.
> **Posture:** reuse the shipped suppression/DSAR/consent machinery; **design three net-new modules**
> — GDPR Art.14 source-notice, India DPDP, and the TCPA/DNC pre-dial pipeline. All external claims are
> already adversarially verified in `01 §5`; this doc **cites, it does not re-research**. **This is a
> design for engineering controls, not legal advice — privacy counsel must review before launch.**
> **No code changes in this gate.**

## 1. Reuse map (cite — do not re-derive)

| Already designed / built | Where |
|---|---|
| Suppression unbypassable, **in-transaction**, tri-scoped (global/tenant/workspace) | `08-compliance.md §3`; `db/src/rls/billing.sql:62-81`; ADR-0009 |
| `assertNotSuppressed` runs inside reveal-tx **and** send-tx | `08 §3` |
| Ingest-time set-based suppression screen (bulk import) + export-time anti-join | `08 §3.1/§3.2` |
| `consent_records` per subject × jurisdiction (lawful_basis, source, validity, withdrawal) | `08 §2`; `03-database-design.md §8` |
| Objection/opt-out → auto `global` suppression + consent withdrawal | `08 §2` |
| DSAR access/delete/rectify; golden-identity fan-out + verification scan | `08 §4`; ADR-0021 deletion cascade; `prospect-company-data` PLAN_00 §6.4 |
| Append-only audit (`audit_log` customer-visible, `platform_audit_log` staff) | `db/src/rls/{billing,platform}.sql`; `audit-log-enum.md` |
| Data-broker posture (CA Delete Act/DROP) as a GA-gating obligation | ADR-0021 consequences; `08`; `research/sales-intelligence-data-research.md §2` |
| CCPA/CPRA (no B2B exemption; opt-out of sale/share; GPC) | `08`; `list-plan/01-research-summary.md §F.3` |

**Conclusion:** GDPR + CCPA + suppression + DSAR + audit are designed. `08-compliance.md` is titled
"GDPR + CCPA" — three gaps remain: **GDPR Art.14 record-level source-notice**, **India DPDP**, and
**telephony (TCPA/DNC line-type + pre-dial scrubbing)**.

## 2. Net-new A — GDPR Art.14 record-level source-notice

`08 §2` covers "right to be informed" via a **public privacy notice**. The research (`01 §5.4`) shows
that is **insufficient** for indirectly-obtained data: Art.14 imposes a **record-level** duty to tell
each subject the **source** of their data (Art.14(2)(f)), and the "disproportionate effort" escape is
narrow (Bisnode/UODO fine; the Dutch DPA Clearview Art.14 finding — note `01 §5.4` corrects the common
CNIL mis-cite). Design:

- **Trigger (Art.14(3)):** within a reasonable period, **at latest 1 month** after obtaining the data,
  **or at first communication** with the subject, **or at first disclosure** to a recipient —
  **whichever is earliest**. Practically: the notice fires at **first outreach** (the send pipeline)
  or first export/disclosure, whichever comes first, and otherwise on a 1-month sweep.
- **Content:** controller identity, purposes + **legal basis**, categories, recipients, retention,
  rights (incl. object), and **the source** — answered from `04-provenance.md §2.2`
  (`field_provenance.src` + `source_records.lawful_basis_snapshot` + `consent_records`).
- **Mechanism:** a `source_notice` ledger (per subject, per controller-context) recording that the
  Art.14 notice was rendered/sent + when + via which trigger — so the obligation is **provable**
  (mirrors how DSAR completeness is made provable via the golden identity). A website notice alone is
  recorded as *insufficient on its own* for the active-contact population.
- **Basis limits:** legitimate interest (Art.6(1)(f)) requires a documented **LIA**; the right to
  object to direct marketing is **absolute** → existing objection→global-suppression path (`08 §2`).
  ePrivacy gates the *send* separately (consent in some member states) — flagged for per-country legal
  review, not engineered here.

## 3. Net-new B — India DPDP module

`08` does not cover DPDP. Per `01 §5.1` (verify verdict: sound): **no B2B carve-out** (the product is
a Data Fiduciary); the public-data exclusion (s.3(c)(ii)) is **narrow and unreliable for scraped
data**; **there is no "legitimate interests" basis** — lawful processing needs **consent** (s.5 notice
+ s.6) or a **closed-list s.7 legitimate use**. Design:

- **Lawful-basis model for India subjects:** extend `consent_records` semantics so an India-jurisdiction
  row **cannot** record `legitimate_interest` as a basis (it does not exist under DPDP); allowed bases
  are `consent` or an enumerated s.7 use (e.g. s.7(a) voluntary provision). This is a **per-jurisdiction
  validation rule** on the existing `consent_records` table, not a new table.
- **Notice (s.5):** the Art.14 `source_notice` mechanism (§2) generalizes — DPDP s.5 notice content
  (data + purpose, how to exercise rights, how to complain to the Board) is a jurisdiction variant.
- **Rights:** access summary (s.11), correction/erasure (s.12), grievance (s.13) → reuse the DSAR
  intake/fan-out (`08 §4`) with a grievance-response SLA; erasure duty on withdrawal/purpose-completion
  (s.8(7)) → reuse the deletion cascade.
- **Timeline:** core penalty-bearing obligations bite **13 May 2027** (`01 §5.1`) — this module is a
  GA-gating obligation for processing Indian Data Principals, ceiling ₹250 crore.

## 4. Net-new C — TCPA / DNC pre-dial pipeline + line-type gating

`08 §3` covers *suppression*-style DNC, but not **registry scrubbing** or **line-type gating** (the
dialer is greenfield). Per `01 §5.3`. Design a **pre-dial pipeline** that composes with suppression:

1. **Line-type gate** — classify mobile vs landline vs VoIP via the `PhoneLineTypePort`
   (shared with `03 §2.3` — one lookup, two consumers). Autodialed/prerecorded **marketing to
   wireless** requires **PEWC**; landline is looser; informational autodialed calls to wireless need
   "prior express consent" (not PEWC). The gate selects the required consent level and blocks if it is
   absent.
2. **National DNC scrub ≥ every 31 days** (max staleness) + **internal/company DNC honored
   immediately** + **state registries** + the **FCC Reassigned Numbers Database** (safe harbor) —
   run **before any dial/text**.
3. **One-to-one consent rule is vacated** (IMC v. FCC, 24 Jan 2025) — bundled lead-gen consent is
   federally permissible; the prior PEWC standard governs. Do **not** build the one-to-one constraint.
4. **CAN-SPAM (email):** honor opt-out ≤10 business days; opt-out mechanism live ≥30 days; valid
   physical postal address; truthful headers. (The send pipeline already injects these — `06`/`08`.)

**Composition with suppression:** the existing tri-scoped `suppression_list` remains the unbypassable
in-tx gate; the pre-dial pipeline is an **additional, telephony-specific** screen that runs before the
dial and **feeds** suppression (e.g. a DNC hit or a reassigned number adds/uses a suppression row).
SMS shares the same gates (`26 §7` open question 3).

## 5. Target schema

| Table | Add | Rule |
|---|---|---|
| `consent_records` | per-jurisdiction basis validation (India: no `legitimate_interest`) | rule, not a new column; reuse existing table (`03 §8`) |
| `source_notice` (new) | `subject_identity_ref`, `trigger` (1mo/first-contact/first-disclosure), `rendered_at`, `jurisdiction`, `content_version` | provability ledger for Art.14/DPDP s.5; append-only |
| `suppression_list` | (reuse) `match_type` already incl. `phone` | DNC/reassigned hits add scoped rows |
| (pre-dial config) | DNC scrub cadence, registry subscriptions | config-injected, never hardcoded; ops-owned |

DSAR/deletion cascade, suppression, audit, `consent_records` — **cite `08`/ADR-0021, do not re-freeze.**

## 6. RLS / scoping implications

`consent_records`/`suppression_list`/`source_notice` are tenant/workspace-scoped where they carry a
tenant (the global-scope suppression rows are the cross-tenant case, managed by staff). DSAR fan-out
and global-suppression writes run under the **privileged** path (`withPrivilegedTx`/`withPlatformTx`,
audited) — the one sanctioned cross-workspace path (DM4; `01 §3.5`). Suppression remains **in-tx and
unbypassable** (DM7). Audit is append-only.

## 7. Scale-gate analysis

| Breaks first | Why | Fix |
|---|---|---|
| Per-row suppression at bulk | million-row import can't loop `assertNotSuppressed` | **already solved:** set-based ingest screen + export anti-join (`08 §3.1/§3.2`) |
| Art.14 notice fan-out | notice per subject at scale | batch the 1-month sweep; trigger inline only at first-contact/first-disclosure; `source_notice` write is append-only, partitionable |
| DNC scrub volume | National-DNC + reassigned-number lookups before each dial | scrub in batches on the pre-dial queue; cache registry results within the 31-day window; line-type from `PhoneLineTypePort` cache |

## 8. Failure modes

- **F1 — website notice treated as sufficient for Art.14:** prevented by §2 (record-level
  `source_notice` + the "insufficient alone" rule; Bisnode/Dutch-DPA exemplars).
- **F2 — `legitimate_interest` recorded for an India subject:** prevented by §3 per-jurisdiction
  validation.
- **F3 — dial before scrub/line-type gate:** the pre-dial pipeline is a hard gate before the dialer;
  a path that dials without it is a release blocker (mirrors the suppression-unbypassable rule).
- **F4 — suppression bypass:** structurally prevented (in-tx, `08 §3`); unchanged.

## 9. Open questions

1. **Per-country ePrivacy / e-marketing** consent rules (Germany UWG, Poland PKE, the C-654/23 soft
   opt-in) need a per-jurisdiction legal review before send-enablement — owner: counsel + compliance
   (`01 §5.4`).
2. **Data-broker registration** scope beyond CA (Texas/Oregon/Vermont) — owner: counsel; GA-gating.
3. **DNC registry subscriptions + state registry count** + the reassigned-number DB integration —
   owner: `truepoint-operations`; ships with the dialer.
4. **Current CAN-SPAM per-email penalty figure** (annually inflation-adjusted) — do-not-rely on an
   older number (`01 §5.3`); confirm at build.
