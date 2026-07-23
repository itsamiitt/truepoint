# 07 — Data Governance

> **Priority:** P0 · **Effort:** 10–14 eng-weeks (engineering) + a parallel legal track ·
> **Phase:** F2 (engineering core); the legal track **starts in F1**; registrations, the Art-14
> notice program, and DPDP gap work land in F3
> (phases are defined in 17-phased-implementation-roadmap.md)

## Executive summary

This document covers provenance, lineage, audit immutability, DSAR (subject access and
erasure), retention, suppression, and the regulatory program — the **compliance spine** — for
Forge. It is the "where sales-intelligence vendors actually die" document: Bisnode was fined for
skipping GDPR Art. 14 notices, Proxycurl was litigated out of existence over its collection
posture, and California's Delete Act now imposes a mandatory deletion platform (DROP) that
brokers must poll every 45 days **starting 2026-08-01 — ten days after this audit's date**.
Forge's current governance surface is a set of empty vessels: provenance columns exist but are
never populated (the parse upsert drops the parser's provenance and blind-index outputs,
P-01.3), `dsar.ts` is a pure erasure *plan* with no executor and no subject index to key on
(P-01.23), `consent_snapshot` never propagates past bronze, the audit hash-chain forks under
concurrency and is not append-only-enforced (P-01.18), and there is no retention policy, no
suppression check, and no lineage plane anywhere in the forge schema. Meanwhile the main app
already ships the primitives Forge needs — a platform-owned `dsar_requests` workflow, a
scoped `suppression_list`, `consent_records`, and a shadow-first retention engine — and Forge
uses none of them (P-01.31). The headline recommendation: build a **provenance-first model**
(per-field `source_type` + `source_detail` + `captured_at` + `lawful_basis` +
`contract_version`) that simultaneously satisfies Art. 14(2)(f) named-source disclosure and
serves as the DSAR data map; wire a **cross-layer DSAR executor** keyed on the unified blind
index; check a **suppression ledger at ingest and every egress**; and run compliance as a
**P0 workstream from F1, not a phase-9 gate** — the planning suite's own GA checklist
(`ga.ts`) already encodes DPIA/LIA/Art-14/DPDP as blockers, and the regulatory calendar does
not wait for phase 9.

## Current state

### Forge's governance surface today (built, mostly dead)

**Provenance columns exist and are never populated.** Silver `parsed_records` carries
`field_provenance jsonb NOT NULL DEFAULT '[]'`
(`packages/db/src/migrations/0070_forge_schema.sql:78`) alongside `block_key`,
`email_blind_index`, and `phone_blind_index` (`0070:81-83`) — but the parse upsert omits the
parser's `channels`/`blockKey` outputs entirely, so all of these are always NULL/empty in any
row the pipeline writes (P-01.3; `packages/forge-core/src/parseStage.ts` vs
`packages/db/src/repositories/forge/parsedRecordRepository.ts:15-17`). The only parser,
`voyagerProfile.ts`, computes an email blind index and a block key that die at the repository
boundary. Gold `verified_records` has no provenance column at all (`0070:113-131`); nothing
records *which source, captured when, under what basis* produced a golden field.

**Lawful basis and consent stop at bronze.** `raw_captures.consent_snapshot` is a free-form
`jsonb NOT NULL DEFAULT '{}'` (`0070:17`) — unvalidated, unqueried, and never propagated to
silver, gold, or the sync outbox (P-01.23). There is no `lawful_basis` column on any forge
table. Tenant attribution itself disappears after bronze (`parsed_records`,
`verified_records`, and `sync_outbox` carry no tenant id, P-01.23), so per-source,
per-jurisdiction basis tracking is structurally impossible past the first layer.

**DSAR is a plan without an executor or a key.** `packages/forge-core/src/dsar.ts:25-33`
builds a five-step erasure plan (raw blob delete → raw tombstone → silver tombstone → gold
tombstone → production suppression event) keyed on a subject blind index, with helper
invariants (`reachesAllLayers`, `isPiiFree`, `dsar.ts:36-44`). It has **zero production
callers** (fact pack §3.1). Worse, the plan cannot even locate its subject: `raw_captures`
has no blind-index column at all (`0070:7-26`), silver's `email_blind_index` is always NULL
(P-01.3), gold's `email_blind_index` is populated only from the client-supplied promotion
payload (P-01.11) and has **no index** (`0070:133` indexes `content_hash` only), and the
forge blind index cannot match the main app's "globally unique dedup + DSAR key" anyway
because the two implementations differ on key, encoding, and normalization, and the sync seam
decodes hex as base64 (P-01.6).

**Erasure cannot reach production.** The `raw_captures.status` value `'erased'` (`0070:25`)
is never set by any code; `verified_record_events` only ever receives `("verified", 1)` and
the typed `verified.suppressed` event is never emitted (fact pack §3.2); the in-process sync's
`applyItem` *can* flip `master_persons.is_suppressed` on a `suppressed` event — but no code
produces that event, and `master_id_map` is never written (P-01.20), so there is no
forge→master join key for erasure propagation even if one were emitted.

**The audit chain is tamper-evident in name only.** `forge.forge_audit_log` (`0070:220-229`)
implements `prev_hash`/`row_hash` chaining, but `prev_hash` is fetched with a plain
`SELECT max(seq)` before insert (`packages/db/src/repositories/forge/promotionRepository.ts:98-117`)
— concurrent promotions fork the chain — and `leadwolf_forge` retains UPDATE/DELETE on the
table with no append-only trigger or REVOKE (P-01.18). There is no WORM anchoring, no chain
verifier job, and no retention class protecting it.

**No RLS, no purpose logging, owner credentials everywhere.** The forge schema has no RLS
(P-01.24; `packages/db/src/schema/forge.ts:2-4`); every forge service connects with the owner
DSN and reaches `leadwolf_forge` only via `SET LOCAL ROLE` (P-01.22). No read of PII is
purpose-logged; there is no break-glass mechanism; the console has no audit or DSAR surface
(P-01.25). The AI-extract stage sends the **full verbatim raw payload** to Anthropic
(P-01.21; `apps/forge-worker/src/processors.ts:108`) — a processor relationship with
disclosure and retention consequences (Batch API results persist 29 days at the provider,
fact pack §11.2) that no governance artifact currently records.

**The GA gate encodes the obligations but nothing feeds it.** `packages/forge-core/src/ga.ts:6-15`
defines `GaReadiness` with `dpiaSigned`, `liaSigned`, `art14NoticeReady`,
`dpdpConsentPosture`, `singlePurposeDeclared`, and `darkConnectorRetired` as hard blockers
(`ga.ts:23-34`). Like `dsar.ts`, it is test-only code — the checklist exists; the program
behind it does not.

### The main app's compliance spine (built, working, ignored by Forge)

The platform Forge nests inside already has the governance primitives the planning suite
told Forge to reuse (fact pack §2.3):

- **`dsar_requests`** — a platform-owned subject-rights workflow
  (`packages/db/src/schema/compliance.ts:46-66`): `request_type IN
  ('access','delete','rectify')`, `subject_email_enc` (encrypted, never plaintext),
  `subject_email_blind_index` ("the find-everywhere key"), a `scope_report` jsonb for the
  assembled access report or erasure proof, and a verified/processing/completed lifecycle.
  RLS is deny-all for the app role — reachable only via the privileged path
  (`packages/db/src/rls/compliance.sql:14-18`), matching FIXED decision #8 ("DSAR is
  platform-owned via privileged role").
- **`consent_records`** — lawful basis per contact × jurisdiction with a closed enum
  `('legitimate_interest','consent','contract','public_record')`
  (`packages/db/src/schema/compliance.ts:15-43`).
- **`suppression_list`** — gates reveal AND send, checked in-transaction, with scopes
  `global|tenant|workspace` (`packages/db/src/schema/billing.ts:155-187`) and full RLS
  policies (`packages/db/src/rls/billing.sql:64-83`); merge logic treats suppression as
  unbypassable (`packages/db/src/repositories/contactMergeRepository.ts:378-385`).
- **A retention engine control plane** — `retention_class_policies` (per-data-class TTL,
  `disabled|shadow|enforce`, shadow-first) and append-only `retention_runs` evidence
  (`packages/db/src/schema/retention.ts:27-58`), seeded with 14 data classes. **No forge
  data class exists**, and the forge schema is invisible to the (planned) sweep.

Forge duplicates or ignores all of this: a second (empty) approval system, a second
(incompatible) blind index, dead `email_enc`/`phone_enc` columns beside the main app's
working `encryptPii`, and a dead-letter posture that never persists — the ×14 duplication
inventory (P-01.31, `16-technology-recommendations.md`).

### What the planning suite intended (intent, not reality)

The frozen suite (`docs/planning/forge/`, doc 14 security + doc 08-adjacent compliance
material) specifies a cross-layer DSAR orchestrator, per-layer raw-PII posture
(raw encrypted, silver blind-index-only, gold ciphertext + blind index), KMS envelope
encryption, per-source LIA/Art-14/DPDP consent gates, a per-hop lineage plane
(OpenLineage + W3C PROV), and a tamper-evident audit chain — **all G-FORGE-tagged as unbuilt
at freeze** (fact pack §2.1, §2.4). Capture and sync are mandated DARK until legal sign-off
(OQ-2, suite invariant 6) — the one governance control that currently holds, because the
kill-switches default off (fact pack §4.1).

## Problems identified

Ordered by severity. **BUG** = wrong today · **GAP** = missing capability · **DEBT** = works
but won't scale/maintain · **RISK** = exposure.

- **P-07.1 — RISK · The regulatory clock is running and nothing is filed, polled, or
  noticed.** California's Delete Act requires annual data-broker registration by Jan 31
  ($6,000 for 2026) and mandates that brokers poll the DROP deletion platform **every 45
  days and process requests within 45 days from 2026-08-01** — days away at audit date —
  with an active CPPA enforcement strike force; Texas ($300), Vermont ($100), and Oregon
  registrations also apply, ~20 comprehensive state laws are in effect for 2026, and 8–12
  states require honoring GPC (fact pack §9.5). Whether TruePoint's *current* master dataset
  already triggers broker status is a counsel question; the deadlines are not. No
  registration, no DROP poller, and no Art-14 notice program exists in the repo (repo-wide:
  the only DSAR/suppression code is the main-app spine above). This is the single largest
  unpriced liability in the program.

- **P-07.2 — GAP · No provenance is recorded anywhere in the live path.** `field_provenance`
  is dropped at parse (P-01.3), gold has no provenance column, and the sync payload carries
  only `{contentHash, entityKind, emailBlindIndex, phoneBlindIndex}` (fact pack §3.2).
  Without per-field source attribution, GDPR Art. 14(2)(f)/15(1)(g) source disclosure is
  unanswerable (CNIL has rejected generic "partner" answers — fact pack §9.5, decision URL
  unverified), survivorship cannot justify a winning value (`05-entity-resolution.md`), and
  quality scoring has no source trust signal (`04-data-quality-framework.md`).

- **P-07.3 — GAP · Lawful basis is never captured, validated, or propagated.**
  `consent_snapshot` is free-form jsonb, empty by default, and stops at bronze (`0070:17`,
  P-01.23). No forge table records *which* Art. 6 basis (or DPDP consent state) covers a
  record, so an LIA cannot be evidenced per record, a basis-scoped erasure ("delete
  everything held under consent") cannot be executed, and the KNLTB-style legitimate-interest
  defense has no factual substrate.

- **P-07.4 — GAP · DSAR has no executor.** `dsar.ts` plans; nothing executes, and nothing
  connects the plan to the main app's `dsar_requests` workflow. GDPR's one-month clock
  (extendable) and CCPA's 45+45 days (fact pack §9.6) cannot be met by a plan object with
  zero callers. The NFR the suite itself commits to — "DSAR ≤1 month incl. raw" (fact pack
  §2.5) — is unmeetable today.

- **P-07.5 — BUG · The DSAR plan cannot find its subject.** The plan keys on a subject blind
  index, but: bronze has no subject-key column; silver's `email_blind_index` is always NULL
  (P-01.3); gold's blind index is client-supplied (P-01.11) and unindexed (`0070:133`); and
  the forge↔main blind-index seam is cryptographically broken (P-01.6) with a committed dev
  fallback key (P-01.14). Until the blind index is unified (F1, S.2 #2), *no* store can be
  reliably queried by subject — the erasure fan-out would silently miss layers, which is
  worse than failing loudly.

- **P-07.6 — GAP · No suppression check exists at forge ingest or egress.** `landEnvelope`
  never consults any suppression source before landing a capture; the sync `applyItem` never
  checks `suppression_list` before minting master identity rows. An erased-on-request subject
  re-enters the dataset on the next capture — the exact re-ingestion failure the Delete Act's
  continuous-deletion duty and GDPR Art. 17 both target (fact pack §9.5, §9.6). The main
  app's `suppression_list` gates reveal and send but is never consulted by any forge path
  (verified: no forge reference to `suppressionList`/`suppression_list`).

- **P-07.7 — GAP · Erasure cannot propagate to the serving layer.** `verified.suppressed`
  is typed but never emitted; `is_suppressed` on `verified_records` (`0070:124`) has no
  writer; `master_id_map` is never populated (P-01.20). Even a working executor would strand
  erasure at gold with no join key into `master_*`.

- **P-07.8 — GAP · No retention policy covers the forge schema.** `retention_class_policies`
  has no `forge_*` data class; `status='erased'` is never set; plaintext raw PII
  (`payload_inline text`, no column encryption despite the config comment claiming it —
  `packages/config/src/forge.ts:6`, fact pack §3.2) is retained indefinitely. This violates
  storage limitation (Art. 5(1)(e)) posture and inflates breach blast radius for zero
  product value once payloads move to object storage (`09-storage-strategy.md`).

- **P-07.9 — BUG/RISK · The audit hash-chain forks under concurrency and is not
  append-only.** `SELECT max(seq)` then INSERT races (P-01.18); `leadwolf_forge` can UPDATE/
  DELETE `forge_audit_log`; there is no anchor to immutable storage and no verifier. A chain
  that can fork and be rewritten fails the SOC 2 tamper-evidence bar and cannot serve as
  erasure proof ("audit keeps IDs, never PII" — FIXED decision #8 — presumes the audit
  itself is trustworthy).

- **P-07.10 — GAP · There is no lineage plane.** No per-record pipeline-state or per-hop
  lineage exists (the pipeline-state table is doc 08's remit; the governance consequence is
  here): reprocessing cannot be explained, an unmerge cannot cite the evidence trail
  (`05-entity-resolution.md`), and an access request cannot state which capture produced
  which golden field. The planning suite's OpenLineage/PROV lineage plane is G-FORGE-tagged
  unbuilt (fact pack §2.4).

- **P-07.11 — RISK · Access governance is absent where the most sensitive data lives.**
  No purpose logging on PII reads, no break-glass procedure, owner-DSN credentials in every
  forge process (P-01.22), no RLS backstop (P-01.24), and a public second origin exposing
  unauthenticated operational endpoints (fact pack §4.4; enforcement details in
  `13-security.md`). SOC 2 requires who/what/when on data access with tamper evidence (fact
  pack §9.7); none of that is producible today.

- **P-07.12 — DEBT · Two governance stacks are diverging.** Forge's dead approval table,
  dead encryption columns, incompatible blind index, and planned-but-absent DSAR duplicate
  main-app systems that already work (P-01.31). Every future obligation (DROP deletions,
  DPDP consent states, notice logs) would otherwise be implemented twice and drift — the
  compliance spine must be **one** spine spanning both schemas.

## Research findings

**Lawful basis (GDPR).** Every major B2B data vendor relies on Art. 6(1)(f) legitimate
interest, supported by Recital 47 (direct marketing "may be regarded as" an LI) and a
documented LIA/DPIA (fact pack §9.5). CJEU *KNLTB* C-621/22 (Oct 2024) confirmed purely
commercial interests can qualify as legitimate interests, subject to necessity and balancing
([CJEU case C-621/22](https://curia.europa.eu/juris/liste.jsf?num=C-621/22)); EDPB Guidelines
1/2024 formalize the three-part test
([EDPB Guidelines 1/2024](https://www.edpb.europa.eu/our-work-tools/documents/public-consultations/2024/guidelines-12024-processing-personal-data-based_en)).
Basis must be *recorded per record*, not asserted globally — which is exactly what the
provenance model provides ([GDPR Art. 6](https://gdpr-info.eu/art-6-gdpr/)).

**Art. 14 notice is existential.** The Polish DPA fined Bisnode (~€220K) because a website
privacy notice was "too passive" for scraped-register data — active notice to subjects was
required ([UODO press release](https://uodo.gov.pl/en/553/1009), fact pack §9.5); Poland's
Supreme Administrative Court (2023) read the Art. 14(5)(b) "disproportionate effort"
exemption **restrictively** for commercial databases (fact pack §9.5 — judgment URL
unverified). Art. 14(2)(f) requires disclosing the source, and specific naming is expected
([GDPR Art. 14](https://gdpr-info.eu/art-14-gdpr/)); Cognism's practice of emailing data
subjects with an opt-out is the survivable competitive precedent (fact pack §9.5). Notice
cost must be budgeted into unit economics — it is a per-record cost of goods.

**Collection posture.** The Dutch DPA holds private-sector scraping is "almost always" a
GDPR violation ([Autoriteit Persoonsgegevens guidance, 2024](https://www.autoriteitpersoonsgegevens.nl/actueel/ap-scraping-bijna-altijd-illegaal)
— URL unverified); EDPB Guidelines 03/2026 (adopted 2026-07-07, fact pack §9.5 — URL
unverified) state that publishing online is not consent, accept LI with a cumulative test,
and treat robots.txt/login walls as feeding "reasonable expectations." In the US, hiQ's CFAA
win was followed by LinkedIn winning on breach of contract
([hiQ Labs v. LinkedIn](https://en.wikipedia.org/wiki/HiQ_Labs_v._LinkedIn)), and LinkedIn v.
Proxycurl (Jan 2025) ended with Proxycurl shutting down in July 2025
([Proxycurl farewell post](https://nubela.co/blog/goodbye-proxycurl/) — URL unverified).
Contract/ToS claims, not CFAA, are the kill vector; the **visible-DOM, user-initiated
capture posture is the survivable one** — directly supporting S.2 #8's recommendation
against MAIN-world interception as primary (P-01.30; the extension question is
`13-security.md`'s remit). This audit takes the compliance-positive reading only: the
posture exists to honor user expectations and platform terms, not to evade them.

**US state regime.** CCPA's B2B exemption expired 2023-01-01; the Delete Act (SB 362)
created the DROP platform with the 45-day polling duty from 2026-08-01
([SB 362 text](https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202320240SB362);
[CPPA data broker registry](https://cppa.ca.gov/data_broker_registry/); fee and dates per
fact pack §9.5). Texas, Vermont, and Oregon maintain separate broker registries (fact pack
§9.5 — registry URLs vary; unverified). GPC universal opt-out is legally binding in 8–12
states ([Global Privacy Control](https://globalprivacycontrol.org/)).

**India DPDP.** TruePoint is India-domiciled (`truepoint.in`). DPDP Rules were notified
2025-11-14 with phased effect — consent-manager provisions ~Nov 2026, substantive
obligations (notice, 72-hour breach, erasure, significant-data-fiduciary duties) ~May 2027
(fact pack §9.5; [MeitY data protection framework](https://www.meity.gov.in/data-protection-framework)
— URL unverified). DPDP is **consent-centric: the GDPR legitimate-interest playbook does not
port.** Scoping (an Indian controller processing non-resident subjects; the Act's
territorial and contract-processing carve-outs) is a counsel question that must be answered
before GA — `ga.ts:11` already blocks GA on `dpdpConsentPosture`.

**Deletion engineering.** The ICO-accepted position for backups is "put beyond use": prompt
live deletion, bounded and documented backup aging, and a restore runbook that **replays the
deletion/suppression ledger after any restore**
([ICO right-to-erasure guidance](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-erasure/)
— path unverified). Crypto-shredding (per-subject DEKs, destroy the key) provably erases
backups but is heavyweight for a search-centric store — defer unless a contract demands it
(fact pack §9.6). A DSAR must reach every store: OLTP, derived indexes, object storage,
Redis/queues, and processor-side retention. Suppression lists are hashed tombstones checked
at every ingest and outbound touch (fact pack §9.5, §9.6).

**Lineage and catalogs.** Self-hosted DataHub needs Kafka + MySQL/PG + Elasticsearch and
≥3 nodes ([DataHub deployment docs](https://datahubproject.io/docs/deploy/)); OpenMetadata is
lighter ([OpenMetadata docs](https://docs.open-metadata.org/)); Marquez is lineage-only
([Marquez](https://marquezproject.ai/)). Any self-hosted catalog costs ~0.5–1 FTE — **overkill
here** (fact pack §9.3). Minimal-viable lineage = per-record provenance + per-field source
attribution, with [OpenLineage](https://openlineage.io/) events layerable later; the trigger
for a catalog is ≥3 data engineers / ≥5 stores / enterprise lineage demand.

**Audit immutability.** The practical form is append-only + per-event hash chained to the
previous + periodic segment-root anchoring to WORM object storage with versioning + object
lock ([S3 Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html);
[R2 object lock](https://developers.cloudflare.com/r2/buckets/object-lock/) — R2 URL
unverified); SOC 2 expects ~12-month audit retention (fact pack §9.6). No blockchain.

**Access governance.** RBAC for coarse capability + ABAC conditions (maker ≠ checker is an
ABAC owner-equality predicate); break-glass = pre-authorized, time-limited, fully logged,
alert-on-use, mandatory post-review; purpose-based access (log *why* PII was accessed) maps
to GDPR purpose limitation and SOC 2's who/what/when demands (fact pack §9.7).

## Enterprise best practices

The bar a ZoomInfo/Apollo/Cognism-class vendor clears: a **public privacy center** naming
categories of sources and stating a verification cadence (the cadence statement doubles as a
sales asset — fact pack §9.4); **active Art-14 notice** with opt-out at first inclusion of an
EU subject (Cognism's model); **registrations current** in every broker registry and a DROP
pipeline that runs on schedule; **suppression that actually sticks** — deletion requests
become durable hashed tombstones that survive re-scrapes, list purchases, and CRM imports;
**per-field provenance** powering both the trust ranking in survivorship and the
source-disclosure answer in a DSAR; **one DSAR workflow** that reaches every store including
object storage and processor retention, with proof artifacts; and an **audit trail an
external auditor accepts** (append-only, anchored, verifiable). None of this is optional at
enterprise sales time: SOC 2 Type II and a credible GDPR/DPDP story are procurement gates,
and the compliance spine is the evidence factory for both.

## Recommended architecture

The spine is one system spanning the main schema and the forge schema, keyed end-to-end on
the **unified blind index** (F1 prerequisite, S.2 #2 — nothing below works until P-01.6 and
P-01.14 are fixed).

```text
                          ┌─────────────────────────────────────────────────────┐
                          │              COMPLIANCE SPINE (one system)          │
                          │                                                     │
 capture ──► forge ingest │  [1] PROVENANCE  per-field {source_type,            │
   │         (S0)         │      source_detail, captured_at, lawful_basis,      │
   │           │          │      contract_version} written at parse, carried    │
   │     suppression      │      to gold, summarized into master                │
   │     check (hash      │  [2] SUPPRESSION LEDGER  hashed tombstones          │
   │     tombstones) ─────┼──►   checked at ingest AND parse AND every egress   │
   │           │          │      (sync applyItem, exports, search projection)   │
   ▼           ▼          │  [3] DSAR EXECUTOR  dsar_requests (platform-owned)  │
 parse ──► silver         │      → forge-dsar job → map / report / erase /      │
   │     (provenance,     │      suppress / verify across bronze→silver→gold→   │
   │      blind index)    │      master→R2→queues→search                        │
   ▼                      │  [4] RETENTION  forge_* data classes in             │
 gold ──► sync ──► master │      retention_class_policies; leader-locked        │
              │           │      batched sweeps; 'erased' status real           │
              ▼           │  [5] AUDIT  serialized hash chain, append-only      │
        suppression       │      enforced, segment roots anchored to WORM       │
        check (egress)    │  [6] ACCESS  RBAC + ABAC + purpose log +            │
                          │      break-glass                                    │
                          │  [7] REGULATORY PROGRAM  LIA/DPIA, Art-14 notice    │
                          │      log + notifier, broker registrations, DROP     │
                          │      poller (≤45d), DPDP gap plan                   │
                          └─────────────────────────────────────────────────────┘
```

### [1] Provenance-first model (the keystone)

One shared Zod contract in `@leadwolf/types`, one shape everywhere:

```ts
// packages/types/src/forgeProvenance.ts (new; shared Zod contract — FIXED decision #5)
export const fieldProvenanceSchema = z.object({
  field: z.string(),                              // "title", "email", …
  sourceType: z.enum(["user_visible_dom", "import", "enrichment_provider", "manual"]),
  sourceDetail: z.string(),                       // Art 14(2)(f) named source, e.g. "linkedin:voyager-profile"
  capturedAt: z.string().datetime(),
  lawfulBasis: z.enum(["legitimate_interest", "consent", "contract", "public_record"]),
  //                                              ^ mirrors consent_records CHECK (compliance.ts:40)
  contractVersion: z.string(),                    // parser/adapter version that produced the value
});
export type FieldProvenance = z.infer<typeof fieldProvenanceSchema>;
```

Written at parse (the parser already knows source, endpoint, schema version, and capture
time; `lawful_basis` is derived from a **validated** `consent_snapshot` + a per-source basis
default table), persisted into the existing `parsed_records.field_provenance` column, carried
through promotion into a new `verified_records.field_provenance`, and summarized into the
sync payload so `source_records`/master can attribute. This one structure is simultaneously:
the Art. 14(2)(f)/15(1)(g) named-source disclosure, the DSAR data map (which layers hold
which fields for a subject), the survivorship trust input (`05-entity-resolution.md`), and
the quality-score source signal (`04-data-quality-framework.md`). Storage overhead is
~20–30% on contact rows (fact pack §9.8) — acceptable; it is the product's audit trail.

### [2] Suppression ledger, checked at ingest AND every egress

The ledger of record stays the main app's `suppression_list` (scopes already
`global|tenant|workspace`). Because `leadwolf_forge` has no USAGE on `public` (fact pack
§6.4 — an isolation property to preserve, not defeat), forge-side checks read a **forge-local
mirror** fed by the executor:

```sql
CREATE TABLE forge.suppression_tombstones (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_type  text NOT NULL CHECK (match_type IN ('email_blind_index','linkedin_public_id','content_hash')),
  match_key   text NOT NULL,                    -- always a hash/blind index, never clear PII
  reason      text NOT NULL CHECK (reason IN ('dsar_erasure','opt_out','drop_delete','gpc','manual')),
  source      text NOT NULL,                    -- 'suppression_list' | 'drop' | 'operator'
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uniq_suppression_tombstone UNIQUE (match_type, match_key)
);
```

Enforcement points (all fail-closed):

- **Ingest (S0):** `landEnvelope` checks `content_hash` tombstones in the same transaction
  (identical erased content can never re-land; the existing tombstoned row's
  `ON CONFLICT DO NOTHING` already blocks identical hashes — the tombstone table catches the
  case where the raw row was hard-deleted).
- **Parse (S1):** once identity keys exist (blind index, LinkedIn slug), check identity
  tombstones; a hit routes to a terminal `suppressed` disposition, never to silver. This is
  the check that stops *fresh* captures of an erased subject (new content, new hash).
- **Egress (S5 + every export):** `applyItem` runs under `withErTx`, which *can* read
  `public.suppression_list` directly — check before `resolveForImport` mints or links
  anything; the search projector and any export path check the same list. Suppression is
  enforced at every boundary where data leaves a layer, per fact pack §9.5.

### [3] Cross-layer DSAR executor

The request-of-record stays `public.dsar_requests` (platform-owned, RLS deny-all — FIXED
decision #8). A new `forge-dsar` queue (maintenance lane) executes:

```text
dsar_requests (access|delete|rectify), keyed subject_email_blind_index (unified key)
   │
   ├─ MAP     parsed_records.email_blind_index → raw_capture_id → raw_captures + R2 blobs
   │          verified_records.email_blind_index (new index)
   │          master_emails.email_blind_index → person_id  (withErTx)
   │          identity cluster expansion: person → ALL member records   (see 05/06)
   │          search projection · Redis queues (references only, verified PII-free)
   │          processor retention (Anthropic batch results ≤29 days — disclosed, aged out)
   ├─ REPORT  assemble scope_report from field_provenance (access) — the data map IS the report
   ├─ ERASE   raw: delete blob, null payload_inline, status='erased' (tombstone keeps id+hash)
   │          silver/gold: tombstone (superseded/e rased flags), never physical mid-chain
   │          master: emit verified.suppressed → applyItem flips is_suppressed
   ├─ SUPPRESS write suppression_list + forge.suppression_tombstones (hashed, reasoned)
   └─ VERIFY  re-run MAP expecting zero live hits; write erasure proof (counts + audit seq
              range + anchor ref) into dsar_requests.scope_report; audit keeps IDs, never PII
```

Two design consequences the plan in `dsar.ts` missed: (a) **unparsed bronze is invisible to a
blind-index MAP** — the executor must force-parse or scan captures with no `parsed_records`
row (bounded once F1 fixes parse and retention bounds unparsed age); (b) **the DSAR unit is
the resolved person, not one identifier** — once ER v1 lands (F2), MAP expands through the
identity cluster so erasing `a@b.com` erases the person's other observed identifiers too
(`05-entity-resolution.md`, `06-identity-graph.md`: identity resolution is what makes a
person *findable* for DSAR — it is a compliance feature, not just a data feature).

### [4] Retention sweeps

Add forge data classes to the existing control plane (no new engine — FIXED reuse):

| data_class | ttl_days (proposed) | mode at launch |
|---|---|---|
| `forge_raw_captures_unparsed` | 30 | shadow |
| `forge_raw_captures_parsed` | 180 (post-R2 offload: PG pointer only) | shadow |
| `forge_parsed_records_superseded` | 90 | shadow |
| `forge_extraction_runs` | 400 | shadow |
| `forge_review_tasks_closed` | 180 | shadow |
| `forge_audit_log` | NULL (never auto-delete; ≥12 mo SOC 2 floor, WORM anchors kept ≥7 yr) | disabled |

Sweeps are leader-locked, batched (`LIMIT` loops, off-peak), and partition-aware once F3's
pg_partman lands (dropping a monthly partition beats a million-row DELETE). Backups follow
the ICO "put beyond use" posture: documented bounded aging + a restore runbook that replays
the suppression ledger after any restore (the ledger, not the backup, is authoritative).
Current backup cadence is not verified in the repo — documenting it is part of this work.

### [5] Audit hash-chain hardening

Serialize the chain (per-chain advisory lock `pg_advisory_xact_lock(hashtext('forge_audit'))`
around read-prev + insert, or a single-row `audit_heads` allocator), REVOKE UPDATE/DELETE
from `leadwolf_forge` plus a belt-and-braces `BEFORE UPDATE OR DELETE` trigger that raises,
and anchor periodically:

```sql
CREATE TABLE forge.audit_anchors (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  up_to_seq    bigint NOT NULL,
  segment_root text NOT NULL,          -- hash over [prev_anchor.seq+1 .. up_to_seq]
  object_ref   text NOT NULL,          -- WORM object key (R2/S3 object-lock, versioned)
  anchored_at  timestamptz NOT NULL DEFAULT now()
);
```

A daily maintenance job verifies the chain end-to-end against the latest anchor and pages on
mismatch. The DSAR erasure proof cites the anchor, making "we deleted it" independently
checkable. (Serialization + REVOKE are cheap and can land with F2's executor; WORM anchoring
is F3 per S.1.)

### [6] Access governance

RBAC stays the existing `data:read|manage|review|export` capability model (fact pack §5.2);
add: **purpose logging** — any surface that renders raw payload or clear PII (the future
capture-inspection console surface, P-01.25) writes a `pii.read` audit event with an
operator-selected purpose enum; **break-glass** — a time-boxed grant of `data:export`
requiring a reason, alert-on-use, and mandatory post-review; **ABAC** — maker ≠ checker
enforced server-side from pipeline state (F1, fixing P-01.10). Enforcement mechanics
(credential separation replacing `SET LOCAL ROLE` on the owner DSN, RLS-vs-grants for the
forge schema) are `13-security.md`'s remit; governance defines what must be logged and
reviewable.

### [7] The regulatory program (legal track — starts F1)

- **LIA + DPIA** for the capture pipeline (blocks GA per `ga.ts:7-8`; the KNLTB/EDPB 1/2024
  framing makes B2B LI defensible *if documented and balanced*).
- **Art-14 active-notice program:** a `notice_log` (subject key, channel, notice version,
  sent_at, opt_out_at) + a notifier job at first inclusion of an in-scope subject, with
  named sources drawn from provenance; opt-out lands in the suppression ledger. Per-record
  notice cost enters unit economics (`15-cost-optimization.md`).
- **US registrations + DROP poller:** register (CA $6,000, TX $300, VT $100, OR — ~$6.5K/yr
  total, fact pack §9.8); a scheduled job polls DROP at ≤45-day cadence from 2026-08-01,
  matches delivered identifiers against the unified blind index, and executes
  delete + suppress within the statutory window.
- **DPDP gap analysis** with Indian counsel (consent-centric; consent-manager integration
  ~Nov 2026; substantive duties ~May 2027) — scoping first, then a consent-state model that
  the provenance `lawfulBasis` field already has room for.
- Estimated cash: **~$6.5K/yr fees + $10–30K one-time legal** (fact pack §9.8) — trivial
  beside the enforcement alternative.

## Implementation details

Dependency-ordered. Steps 1–2 are F1; 3–8 are F2; 9–12 are F3.

1. **F1 — Start the legal track (no code).** Engage privacy counsel: broker-status
   determination per state; DROP account and process design; LIA/DPIA skeletons; DPDP
   scoping; Art-14 notice content. Owner: leadership + counsel; engineering supplies the
   data-map answers from this document.
2. **F1 — Prerequisites this spine depends on (already in F1 per S.1):** unify the blind
   index (one key, one encoding, one normalization; migrate forge hex → main bytea; kill the
   dev-key fallback) — fixes P-01.6/P-01.14; persist parser registry + parse outputs — fixes
   P-01.1/P-01.3 so silver actually carries `email_blind_index`/`field_provenance`; REVOKE
   UPDATE/DELETE on `forge.forge_audit_log` in the grants block of
   `packages/db/src/applyMigrations.ts` (one-line hardening, testable by the F1 grant
   itests).
3. **F2 — Provenance write path.**
   - `packages/types/src/forgeProvenance.ts` (new): the shared Zod contract above; validate
     `consent_snapshot` at the capture edge with a sibling schema.
   - `packages/forge-core/src/parsers/voyagerProfile.ts` + `parseStage.ts`: emit
     `FieldProvenance[]` per parsed field (sourceType `user_visible_dom`, sourceDetail
     `linkedin:voyager-profile`, contractVersion = parser version, lawfulBasis from the
     validated snapshot + per-source default).
   - `packages/db/src/repositories/forge/parsedRecordRepository.ts`: persist
     `field_provenance`, `email_blind_index`, `block_key` (extends the P-01.3 fix).
   - Migration `packages/db/src/migrations/0071_forge_governance.sql` (next free index —
     verify at write time; the journal already has a duplicate-index wart, P-01.30):
     `ALTER TABLE forge.verified_records ADD COLUMN field_provenance jsonb NOT NULL DEFAULT
     '[]'::jsonb;` plus `CREATE INDEX idx_parsed_records_email_bidx ON
     forge.parsed_records (email_blind_index) WHERE email_blind_index IS NOT NULL;` and the
     same partial index on `forge.verified_records`.
   - `packages/forge-core/src/verification.ts` + `promotionRepository.ts`: carry provenance
     through promotion; include a provenance summary in the outbox payload (also closes the
     payload-keys TODO noted in fact pack §6.1).
4. **F2 — Suppression ledger.** Migration adds `forge.suppression_tombstones` (DDL above);
   `packages/forge-core/src/ports.ts` gains `SuppressionPort` (finally a real port in that
   file); `ingest.ts` checks content-hash tombstones in-tx; `parseStage.ts` checks identity
   tombstones and routes hits to a terminal disposition; `packages/db/src/repositories/forgeSyncRepository.ts`
   `applyItem` checks `public.suppression_list` (it already runs under `withErTx`) before
   resolving/minting. Extend `suppression_list` match types with `email_blind_index` (main
   schema migration) so hashed tombstones exist on both sides of the wall.
5. **F2 — DSAR executor.** New queue `forge-dsar` registered in
   `apps/forge-worker/src/register.ts`; processor in `apps/forge-worker/src/processors.ts`;
   repository `packages/db/src/repositories/forge/dsarRepository.ts` (MAP/ERASE/VERIFY
   queries per layer); the orchestration reuses `packages/forge-core/src/dsar.ts`'s plan
   shape but executes it. A thin platform-side worker (main `apps/workers`) watches
   `dsar_requests` and enqueues `forge-dsar` — the privileged platform role owns the
   workflow, forge executes its slice (FIXED decision #8). Erasure writes
   `status='erased'`, deletes R2 blobs, emits `verified.suppressed` into the outbox, and
   writes tombstones + proof. API: no new public endpoint (DSARs arrive via the existing
   platform intake); console gets a read-only execution view in F3.
6. **F2 — Anthropic processor governance.** Record the processor relationship in the data
   map; configure zero-data-retention with the provider where contractually available (not
   verified in repo); the extraction stage stops sending full raw payloads once the
   deterministic-first cascade lands (S.2 #6, `11-ai-assisted-processing.md`) — until then
   the DPIA must name the transfer explicitly (P-01.21).
7. **F2 — Retention classes.** Seed the six `forge_*` classes into
   `retention_class_policies` (main migration, mirroring `0033_retention_engine.sql`
   seeding); implement the forge sweep in the maintenance processor (leader-locked, batched,
   `withForgeTx`), writing `retention_runs` evidence rows; shadow mode first, per the
   engine's own contract (`packages/db/src/schema/retention.ts:10-12`).
8. **F2 — Audit serialization.** Advisory-lock the chain append in
   `promotionRepository.ts:98-117`; add the raise-on-write trigger; itest: concurrent
   promotions produce one linear chain (extends the F1 itest suite, P-01.28).
9. **F3 — WORM anchoring + verifier.** `forge.audit_anchors` migration; a maintenance job
   computes segment roots, PUTs to an object-locked R2 bucket
   (`packages/integrations/src/forgeObjectStore.ts` gains a WORM-bucket client), and
   verifies daily; alert on mismatch (metrics per `12-observability.md`).
10. **F3 — DROP poller + registrations.** `apps/workers/src/jobs/dropPoller.ts` (main app —
    the obligation attaches to the business, not to Forge): repeatable job at ≤45-day
    cadence, matches DROP identifiers via the unified blind index, files deletions through
    the DSAR executor, writes evidence. Registration filings are calendar work with an
    owner and a renewal runbook (`truepoint-operations` skill territory).
11. **F3 — Art-14 notice program.** Main-schema `notice_log` table + notifier job at first
    inclusion; opt-outs feed the suppression ledger; notice content cites named sources from
    provenance. Legal-led, engineering-supported.
12. **F3 — Console governance surfaces.** Add to the console's missing-surfaces backlog
    (P-01.25): Audit view (chain status, anchors, verifier state), DSAR view (requests,
    execution progress, proofs), Suppression browser (hashed keys only, reason codes),
    Retention dashboard (per-class shadow evidence). All read via new `/bff/governance/*`
    routes with `data:manage`, RFC 9457 envelopes per the F1 contract fix.

## Migration strategy

Everything is **additive and shadow-first**; nothing breaks the (currently dark) pipeline.

- **Now is the cheapest moment in the product's life to do this.** Volume is ~zero, capture
  and sync are dark (suite invariant 6), so provenance backfill is trivial and no erasure
  debt exists. Every week of live capture without provenance creates rows that can never be
  retroactively attributed — a one-way cost.
- **Provenance:** new columns are nullable/defaulted; the parser writes them from day one of
  F2; the handful of existing staging rows are backfilled with
  `sourceDetail='linkedin:voyager-profile'` + `lawfulBasis` from counsel's default, flagged
  `backfilled=true`. A CI contract test (Zod snapshot, BACKWARD rules — fact pack §9.2)
  guards the shape.
- **Suppression:** ship in **shadow** (log would-block hits, land the capture) for two
  weeks of synthetic traffic; flip to enforce per enforcement point via config once
  false-positive rate is measured ≈0. Rollback = flag off; tombstones are inert data.
- **DSAR executor:** dry-run mode first — MAP + REPORT only, no ERASE — validated against
  synthetic subjects seeded across all layers in the F1 itest harness; enable ERASE after
  the verify step proves zero-miss on synthetics. The executor is idempotent (re-running an
  erasure converges), so partial failures re-drive safely.
- **Retention:** the engine's own `disabled → shadow → enforce` ladder, with
  `retention_runs` shadow evidence reviewed before any class flips; `forge_audit_log` never
  auto-deletes.
- **Audit chain:** freeze writes momentarily (promotion volume is zero), verify the existing
  chain, write anchor #0, deploy the serialized writer. If the historical chain is already
  forked (possible under P-01.18), record the fork in anchor #0's metadata and start clean
  — honest lineage beats retconned integrity.
- **Blind-index unification (F1, prerequisite):** dual-write old+new forge indexes during
  the migration window, re-key stored values, then drop the old column — detailed in
  `19-migration-plan.md`; the spine consumes only the unified key.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Broker-status/registration determination arrives after a statutory deadline (DROP polling starts 2026-08-01) | High | High — per-violation fines, CPPA enforcement posture | Start counsel track in F1 (step 1); register defensively if counsel is undecided at deadline; document the analysis either way |
| Blind-index unification slips, blocking DSAR findability | Medium | High — executor ships but cannot MAP reliably | Treat P-01.6/P-01.14 as F1 exit criteria (they already are, S.1); executor dry-run gate refuses to enable ERASE until key-match itests pass |
| Suppression false positives block legitimate captures (hash collisions ≈ nil; stale tombstones real) | Low | Medium — silent data loss at ingest | Shadow mode first; reason codes + source on every tombstone; operator surface to inspect/expire `manual` entries; never expire `dsar_erasure`/`drop_delete` |
| Retention sweep deletes evidence needed for audit or an open DSAR | Low | High | `forge_audit_log` class disabled; sweeps skip rows referenced by open `dsar_executions`; shadow evidence reviewed before enforce |
| Art-14 notice cost at scale surprises unit economics | Medium | Medium | Per-record notice cost modeled in `15-cost-optimization.md` before capture goes live; notice batched by subject, not by capture |
| DPDP substantive rules shift timing/scope (~May 2027 est.) | Medium | Medium | Gap analysis in F3 names decision points + trigger dates; consent-state field already present in the provenance model |
| WORM anchoring misconfigured (object lock off) gives false immutability confidence | Low | Medium | Verifier job asserts object-lock status on the bucket, not just object presence |
| Two governance stacks drift further while F2 is built | Medium | Medium | The spine reuses main-app tables as systems of record (dsar_requests, suppression_list, retention control plane); forge-side tables are mirrors/execution detail only |

## Success metrics

- **DSAR SLO:** automated scope report < 24 h; erasure executed + verified < 7 days;
  end-to-end ≤ 30 days including raw and object storage (the suite's own NFR, fact pack
  §2.5) — measured from `dsar_requests.requested_at` to `completed_at`, 100% within SLO.
- **Provenance coverage:** 100% of new silver rows carry ≥1 `field_provenance` entry with a
  non-null `lawful_basis`; 100% of gold rows carry provenance at promotion; 0 rows with
  empty provenance after F2 cutover (monitored as a data-quality check,
  `04-data-quality-framework.md`).
- **Suppression:** checks active at 100% of ingest/parse/egress/export points; p95 check
  overhead < 5 ms in-tx; **re-ingestion of an erased subject = 0** (tombstone-hit metric
  exists and is alarmed); DROP poll cadence ≤ 45 days with 100% on-time processing.
- **Audit:** daily chain verification green; 0 forks post-serialization; anchor lag ≤ 24 h;
  UPDATE/DELETE on `forge_audit_log` fails for every role (asserted by a CI grant itest).
- **Retention:** in enforce mode, 0 rows older than class TTL per sweep report; 100% of
  sweeps write `retention_runs` evidence.
- **Regulatory:** registrations filed before each deadline (CA Jan 31; TX/VT/OR per
  statute); LIA/DPIA signed before any capture flag flips beyond synthetic tenants
  (`ga.ts` gate wired to real inputs, not test fixtures); Art-14 notices sent within one
  month of first inclusion, opt-out rate tracked.
- **Cost ceiling:** compliance run-rate ≈ $6.5K/yr fees + notice sending; one-time legal
  $10–30K; WORM/object-lock storage < $5/mo at current volume.

## Effort & priority

**P0** because this is the one workstream where the failure mode is not an outage but an
enforcement action or a forced shutdown (Bisnode, Proxycurl), and because a statutory clock
(DROP, 2026-08-01) is already running independent of Forge's build state. The engineering is
deliberately modest — **10–14 eng-weeks** for the 2–3-engineer pod, spread F2 (provenance,
DSAR executor, suppression, retention, audit serialization ≈ 8–10 wks) and F3 (WORM
anchoring, DROP poller, notice program, console surfaces ≈ 3–4 wks) — because the spine
reuses the main app's existing compliance primitives instead of duplicating them, and buys
nothing heavyweight (no catalog, no crypto-shredding, no blockchain). The **legal track
starts in F1** at near-zero engineering cost; sequencing it later converts a cheap paper
exercise into retroactive liability. Phase placement follows S.1: engineering core in F2,
regulatory program completion in F3 — with the explicit amendment that the *legal* work is
front-loaded, making compliance a P0 workstream rather than the planning suite's phase-9
gate.

## Future enhancements

- **Crypto-shredding** (per-subject DEKs; destroying the key erases backups) — deferred per
  the ICO "put beyond use" posture; adopt only if an enterprise contract demands provable
  backup erasure, and then only for high-sensitivity fields (fact pack §9.6).
- **OpenLineage event emission** from the pipeline-state table, then a catalog
  (OpenMetadata first) when the trigger hits: ≥3 data engineers, ≥5 stores, or enterprise
  lineage demand (fact pack §9.3).
- **DPDP consent-manager integration** (~Nov 2026 provision) and a consent-state machine on
  top of the provenance `lawfulBasis` field, per counsel's scoping.
- **Purpose-based access enforcement** (deny-by-default purposes, not just purpose logging)
  and full ABAC policy evaluation at the BFF.
- **Automated Art-15 self-service portal** (subject access without operator involvement)
  once DSAR volume justifies it.
- **Contributory-network consent framework** — doc 20's E7 moat option is a governance
  project as much as a product one; its data-sharing terms must be designed on this spine
  (provenance + basis + suppression) or it inherits every problem in this document at
  partner scale.
