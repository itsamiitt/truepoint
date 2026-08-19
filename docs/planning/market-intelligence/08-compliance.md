# 08 — Compliance posture per pillar [A-01]

Checklist basis: `docs/strategy/09-compliance.md` (six hard rules + PR review gate).
Governing principle from doc 03: market intelligence here is **company facts**. Most of
the series is therefore *outside* personal-data scope — this doc marks exactly where it
is not, because those edges are where the risk lives.

## 1. Pillar classification

| Pillar | Personal data? | Handling |
|---|---|---|
| Firmographics, taxonomy, headcount aggregates, funding, filings, market rollups | **No** — organizational facts | Standard provenance + lawful basis tagging (rule 4 still applies: every ingestion path tags a basis or the data doesn't enter) |
| Technographics | No | Evidence URLs must not embed personal data; adoption rows reference companies only |
| Job postings | **Edge case** — a posting can name a recruiter/contact | Parser strips person names/emails/phones at landing (silver-stage guard, like the forge blind-index discipline); store req facts only |
| Leadership signals (`exec_hired/departed`) | **Yes — references a person** | Signal payload carries `master_persons.id` reference only, never channels (schema contract + `assertNoContactValues`). Public-role employment fact = business-contact data within rule 3 scope. Lawful basis: legitimate_interest via D6 resolution order |
| Job-change signals | Yes (existing path) | Already governed; no change |
| AI research-agent briefs | Potentially | Doc 23 rules bind: grounded on public pages, verified before persist, findings that would add personal data go through the normal provenance write path or are dropped |

## 2. DSAR / erasure propagation (rule: erasure = tombstone → reprocess → suppression)

New person-referencing artifacts join the existing fan-out:
- `master_signals` rows whose `subject_type='person'` or that reference a person: on
  erasure/suppression, the signal is **retained as an anonymized company event or
  deleted** — decision D-8 in doc 09 (retain-anonymized is the default proposal:
  "a VP departed" without the person reference; the company fact is not the subject's
  personal data once unlinked).
- `tenant_signals` projections: covered by rebuild-from-Layer-0 (doc 06 §3) — the
  erasure sweep deletes projections referencing the tombstoned person.
- Watchlists/subscriptions reference accounts only — out of scope.
- `scope_report` for DSAR gains the new tables in its census (test-encoded count:
  tables holding person references NOT covered by the DSAR census = 0).

## 3. Suppression at egress

Open conflict (d) in decisions.md stands: `assertNotSuppressed` has three call sites,
not "every egress". The new surfaces add egress points (company-page People section,
signal feed naming people, alert payloads). **Every new person-rendering read in this
series calls the suppression gate** — and the series budget includes closing the gap on
the pre-existing three-site shortfall for surfaces it touches. AC: count of
person-rendering endpoints in new features without a suppression check = 0.

## 4. Sourcing lawfulness

- Every feed: provider compliance clearance in `provider_configs` before enablement
  (doc 21 §4); the provider's own lawful basis recorded in the lineage chain (doc 21 §5).
- No crawling, no logged-in-site collection (hard constraint 4). Licensed feeds and
  registries under their commercial terms only. Registry commercial-use terms are a
  named procurement decision (doc 09 D-4), not an assumption.
- EU subjects: `region`/`jurisdiction` tags flow through signals as through master rows;
  the per-subject-jurisdiction basis resolver remains a Phase-5 item (D6 known limit) —
  market-intel work does not silently depend on it.

## 5. Retention

New data classes registered with `retention_class_policies` defaults (shadow mode like
everything else): postings (raw feed docs short-lived once normalized), signals
(long-lived, business facts), rollups (rebuildable, minimal), agent briefs (short TTL
cache). The retention engine's per-class enforce flags stay off until the standard
flip process.

## 6. PR gate restated

Every implementation PR in this series that touches collection/storage/display/export/
deletion states: data elements · lawful-basis tag · consent surface (n/a for company
facts — say so) · suppression enforcement point · erasure propagation path. Uncertain →
stop and ask the human (CLAUDE.md rule 3).
