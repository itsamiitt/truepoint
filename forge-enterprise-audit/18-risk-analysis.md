# 18 — Risk Analysis

> **Priority:** P0 (risk visibility gates go/no-go) · **Effort:** ongoing register maintenance ·
> **Phase:** spans all · Cite problems as **P-01.x**; risks are numbered **R-NN**.

## Executive summary

Forge's risk profile is unusual and, on balance, favorable: because so little is load-bearing yet and
capture/sync are dark, **the highest-severity risks are latent, not active** — they become real only
when the flags flip. That is the strategic opportunity the roadmap exploits. The risks fall into six
classes: data-integrity/correctness, security, compliance/legal, scale/reliability, cost, and
execution/strategic. The three that should keep leadership up at night are (1) **flipping capture/sync
before the F1 write-path fixes land** (R-01) — it converts every latent security and integrity defect
into an active breach; (2) **the compliance clock** (R-10) — the California Delete Act's DROP-polling
obligation began 2026-08-01 and registration deadlines and India's DPDP are near, yet the platform is
a scaffold; and (3) **identity corruption from the duplicated blind index / content hash** (R-04) — a
silent, hard-to-detect defect that poisons the master graph and every downstream product built on it.

Every risk below carries a likelihood, an impact, a mitigation, and the document that owns the detail.
The register is meant to be maintained, not archived — likelihoods change as phases complete.

## Current state

The single fact that shapes the whole register: **there is no production data in Forge today.** Capture
(`FORGE_CAPTURE_ENABLED`) and sync egress (`FORGE_SYNC_EGRESS_ENABLED`) default off
(`packages/config/src/forge.ts:24-38`), the extension feeds a main-app stub that stores nothing, and no
customer sees Forge output. So the audit's alarming findings (client-assertable four-eyes, plaintext
PII, cross-tenant poisoning) are **exposures-in-waiting**. The corresponding risk-management posture is
therefore unusually clean: fix them in F1 while the blast radius is zero.

## Problems identified (risk-specific)

- **P-18.1 — RISK · The dark flags are the only thing standing between the doc-01 defects and a
  breach.** They are configuration, not architecture; a well-meaning "let's turn on capture for a demo"
  is a single env change away from activating R-01. The roadmap gates the flags on the F1 security DoD
  (`13-security.md`); that gate must be a process control, not a hope.
- **P-18.2 — RISK · No forge tests in CI means risks are undetectable until production** (P-01.28) —
  the register's detection column depends on tests that do not yet exist.

## Research findings

The compliance and legal risks are grounded in primary sources detailed in `07-data-governance.md`:
the California Delete Act statute and DROP timeline
([CPPA statute](https://cppa.ca.gov/regulations/pdf/data_broker_reg_delete_act_statute_eff_20260101.pdf)),
the EDPB web-scraping guidance ([EDPB PDF](https://www.edpb.europa.eu/system/files/2026-07/edpb_guidelines_2020603_webscraping_v1_en_0.pdf)),
the Bisnode Art-14 line of cases ([IAPP](https://iapp.org/news/a/polish-court-overturns-dpas-first-gdpr-fine)),
the LinkedIn v. Proxycurl outcome ([StartupHub](https://www.startuphub.ai/ai-news/startup-news/2025/the-1-linkedin-scraping-startup-proxycurl-shuts-down)),
and India's DPDP timeline ([SCC Online](https://www.scconline.com/blog/post/2025/12/26/digital-personal-data-protection-rules-2025-key-highlights/amp/)).
The technical risks are grounded in the sibling documents' research.

## The risk register

Likelihood/Impact on a 1–5 scale; **Score = L×I**; ordered by score within class.

### Data integrity & correctness

| ID | Risk | L | I | Score | Mitigation | Owner doc |
|---|---|---|---|---|---|---|
| R-04 | Duplicated blind index / content hash silently corrupts dedup, master-matching, and DSAR (P-01.6/12/31) | 5 | 5 | **25** | Converge into `@leadwolf/identity` in F1 behind a dual-gate + identity-match test before any cutover | 16, 05, 06 |
| R-05 | Pipeline never produces usable data (parse FK break, discarded extraction, no sync scheduler — P-01.1/2/4) | 5 | 4 | 20 | F1 correctness workstream + E2E itest gate | 01, 08, 11 |
| R-06 | Captured observations lost end-to-end (extension → stub → deleted from queue, P-01.5) | 5 | 3 | 15 | Unify the one capture path in F1; retire the `/ingest` stub | 03 |
| R-07 | ER over-merges (no cluster-size/cardinality guards) → wrong people combined, hard to unwind | 3 | 4 | 12 | Guardrails + reversible unmerge + review queue for the grey zone | 05, 06 |
| R-08 | Non-idempotent handlers duplicate review tasks / re-bill Anthropic on redelivery (P-01.16) | 4 | 3 | 12 | Stage idempotency keys as unique constraints; F1 | 08 |

### Security

| ID | Risk | L | I | Score | Mitigation | Owner doc |
|---|---|---|---|---|---|---|
| R-01 | Capture/sync enabled before write-path fixes → active four-eyes bypass, poisoning, PII exposure (P-01.10–15) | 3 | 5 | **15** | Gate the flags on the F1 security DoD as a process control (P-18.1); keep flags off in the deploy template | 13, 17 |
| R-02 | Single `data:review` operator promotes arbitrary records to the golden layer (P-01.10) | 4 | 4 | 16 | Server-enforced four-eyes (insert `approval_requests`, server-derived maker) in F1 | 13 |
| R-03 | Cross-tenant existence oracle / dedup poisoning via global hash (P-01.12) | 3 | 4 | 12 | Per-tenant `capture_claims`; server hash recompute; F1 | 13, 03 |
| R-09 | Plaintext raw PII + default HMAC key + no RLS (P-01.9/14/24) leaks on any breach | 3 | 5 | 15 | Encrypt at rest (R2 SSE-KMS), KMS-managed key, RLS backstop; F1/F2 | 13, 09 |

### Compliance & legal

| ID | Risk | L | I | Score | Mitigation | Owner doc |
|---|---|---|---|---|---|---|
| R-10 | Regulatory clock (CA Delete Act DROP from 2026-08-01; registrations; DPDP ~May 2027) missed while platform is a scaffold | 4 | 5 | **20** | Start the legal track in F1; registrations + DROP poller + Art-14 program in F3 | 07, 17 |
| R-11 | MAIN-world interception (ADR-0046) adopted → Proxycurl-style ToS/contract litigation | 2 | 5 | 10 | Keep dark; recommend visible-DOM; counsel-gated ADR amendment | 07, 13, 03 |
| R-12 | Art-14 notice obligation unmet (Bisnode line: passive notice insufficient for commercial DB) | 3 | 4 | 12 | Active-notice program with opt-out; budget into unit economics; F3 | 07 |
| R-13 | DSAR cannot reach all stores (no executor, no subject index — P-01.23) → erasure is a lie | 3 | 4 | 12 | Cross-layer DSAR executor + subject blind-index index; provenance model; F2 | 07 |

### Scale & reliability

| ID | Risk | L | I | Score | Mitigation | Owner doc |
|---|---|---|---|---|---|---|
| R-14 | Human-review queue becomes the throughput ceiling at volume (5–15K/day human limit) | 4 | 4 | 16 | Deterministic-first extraction + confidence-routing + auto-approve to keep review ≤1% | 14, 11 |
| R-15 | AI-extract spend becomes the cost ceiling (0.5–5M paid calls/day at 10×) | 4 | 3 | 12 | Batch API + prompt caching + content-hash cache + per-tenant budgets | 15, 11 |
| R-16 | In-tx S3 + O(records) land + unbounded COUNT(*) collapse under real ingest (P-01 scaling) | 4 | 4 | 16 | Batch the land, move S3 out of tx, partition, rollups; F1/F3 | 14 |
| R-17 | Redis wipe loses in-flight jobs (no outbox, no durable state) | 3 | 4 | 12 | Postgres-as-pipeline-truth (outbox + state table); Redis becomes re-enqueue | 08 |
| R-18 | Redis memory growth outage (no removeOnComplete/Fail — P-01.17) | 3 | 3 | 9 | removeOnComplete/Fail + noeviction + AOF; F1 | 08 |

### Cost

| ID | Risk | L | I | Score | Mitigation | Owner doc |
|---|---|---|---|---|---|---|
| R-19 | Unbounded AI spend from the in-memory per-capture budget (no real per-tenant/day cap — P-01.21) | 3 | 4 | 12 | Durable per-tenant/day budget breaker; record spend; F1/F2 | 15, 11 |
| R-20 | Premature adoption of a heavyweight platform (Iceberg/Kafka/Temporal/DataHub) burns budget + ops | 2 | 3 | 6 | Trigger-gated adoption; each has an explicit condition | 16 |

### Execution & strategic

| ID | Risk | L | I | Score | Mitigation | Owner doc |
|---|---|---|---|---|---|---|
| R-21 | Plan-vs-build drift left unreconciled → future work follows a stale blueprint | 4 | 3 | 12 | Ratify the nesting + formally amend the planning suite in F1 | 20, 00 |
| R-22 | F1 scope creep pulls F2 capability in, delaying the correctness gate | 4 | 3 | 12 | F1 is strictly "make the built pipeline correct + tested" | 17 |
| R-23 | 2–3-person pod under-resourced for a 9–12-month enterprise build | 3 | 4 | 12 | Sequence ruthlessly; F4 is trigger-gated and deferrable; buy-nothing keeps ops burden low | 17, 15 |
| R-24 | ADR-0046/0047 stay "Proposed" while cited as "Locking" → governance ambiguity | 3 | 2 | 6 | Accept or amend the ADRs as part of F1 plan reconciliation | 01, 20 |

## The top five, expanded

1. **R-04 (score 25) — identity corruption from duplication.** The insidious one: two blind-index
   implementations with different keys/encodings/normalizations mean Forge-synced identities can never
   match main-app identities on the "globally unique dedup + DSAR key," and the failure is *silent* —
   no error, just a slowly poisoned master graph and DSARs that miss records. Mitigation is non-optional
   and first-in-F1.
2. **R-10 (score 20) — the compliance clock.** External deadlines do not wait for the platform to be
   ready. The California DROP-polling obligation is already live; registration is cheap and fast but must
   be *done*; DPDP substantive obligations arrive ~May 2027 and the GDPR legitimate-interest playbook
   does not port to India's consent-centric regime. The legal track cannot be an F3 afterthought.
3. **R-05 (score 20) — the pipeline produces nothing.** Three severed links mean no captured record
   reaches gold today. This is a correctness emergency masked by the dark flags; it is the core of F1.
4. **R-02 (score 16) / R-14 (score 16) / R-16 (score 16)** — the client-assertable golden-layer write,
   the human-review ceiling, and the ingest-path collapse under load. Each is addressed in its owning
   document; each is a "must-fix-before-scale" rather than a "must-fix-before-launch."
5. **R-01 (score 15) — the flag flip.** The meta-risk: the dark flags are the safety, and they are one
   env change from off. Gate them on the F1 DoD as an enforced process control, and keep them off in the
   deploy template until then.

## Recommended architecture (risk controls)

- **Go/no-go gates per phase** (`17`): F1 exit requires the E2E itest + zero client-trusted write-path
  values + the identity-match test; the capture/sync GA gate (F3) requires the compliance spine green
  for a canary tenant. No flag flips without its gate.
- **Detection before enablement:** the forge integration + isolation + identity-match tests (P-18.2)
  land in F1 so every register risk has a detection mechanism before any exposure.
- **A maintained register:** re-score after each phase; R-04/R-05 drop to near-zero after F1, R-10/R-13
  after F2/F3, and the residual profile is dominated by scale (R-14/R-16) which F3/F4 address.

## Risks (meta)

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| The register is written once and ignored | Medium | Medium | Re-score at each phase gate; owner docs keep detail current |
| A new ingestion source adds unassessed risk | Medium | Medium | Threat-model review before enabling any source (`13`) |

## Success metrics

- Every register risk has a detection mechanism (a test or a metric) before its exposure is enabled.
- No capture/sync flag is flipped without its go/no-go gate passing.
- Post-F1 re-score shows R-04 and R-05 at ≤4; post-F3 shows R-10/R-12/R-13 at ≤6.

## Effort & priority

**P0** as a governance artifact — it is the map leadership uses to decide what must be true before each
flag flips. Maintaining it is minutes per phase; ignoring it is how the dark flags flip prematurely.

## Future enhancements

A lightweight risk-acceptance log (who signed off on carrying which residual risk, and until when);
integration of the register with the incident-response runbooks (`truepoint-operations`) so a
materialized risk maps to a known response.
