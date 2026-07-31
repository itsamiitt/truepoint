# Architecture — for Claude Code to plan against

Adapt to the existing system (KICKOFF-PROMPT step 2); the invariants below are
non-negotiable, the service boundaries are suggestions.

## Invariants
1. **Event-sourced contributions.** Nothing writes to the materialized graph
   except through a provenance_event (source, actor/contributor-ref, method,
   timestamp, payload, lawful-basis tag). Enables A-01, A-02 (erasure =
   tombstone + reprocess), A-03 (audit), and confidence computation.
2. **Contributor anonymity by construction.** Records never expose who
   contributed (C-02). Contributor identity lives only in the provenance
   store, access-restricted; public surfaces show counts/recency, not sources'
   identities.
3. **Suppression checked at every egress** (search, reveal, export, API,
   sync-out). One service, one list, enforced everywhere (S-11, A-02).
4. **Extension is user-initiated only.** No background page scraping; content
   scripts read the page the user is on to build context for actions the user
   explicitly takes (reveal/save/confirm). Minimal host permissions. (09 has
   the store-policy/ToS rationale.)

## Core data model (reconcile with existing schema)
- company(id, domain[], name, firmographics…, confidence per field)
- person(id, name variants, links[])                      ← PII-minimal
- employment(person_id, company_id, title, seniority, start/end?, status,
  confidence)                                             ← decay lives here (S-09)
- contact_point(id, person_id, type[email|phone], value, status, confidence,
  last_verified_at, verification_events[])
- provenance_event(id, entity_ref, field, action, source_type, contributor_ref?,
  method, lawful_basis, ts, payload, acceptance_state)
- contributor(id, user_id, reputation, consent_records[])
- subscription(id, account_id, tier, status, ts) · entitlement(account_id,
  feature, cap, source[paid|community]) · usage_event(id, account_id, action, ts)
- suppression_entry(id, subject_ref|value_hash, scope, reason, ts)
- reveal_miss(id, context_fingerprint, demanded_fields, ts)   ← most-wanted feed fuel

## Services (or modules, if monolith — Claude Code recommends in kickoff)
- graph: entity resolution (A-04), merge w/ provenance retention, read API
- ingest: per-channel pipelines (seed, crawl, extension, sync, verification),
  all normalizing into provenance_events
- verify: async workers — email (syntax/MX/SMTP/catch-all), phone (HLR) —
  emitting verification_events
- confidence: scoring + per-field decay half-lives + ground-truth
  recalibration from outcome events (bounces/connects)
- entitlements: subscription tiers, usage metering, feature caps, payment-
  provider integration, Community-status evaluation (channel liveness)
- fraud: reputation, canaries, anomaly + channel-liveness detection (A-03)
- compliance: suppression, DSAR/erasure orchestration, lawful-basis registry,
  audit exports (09)
- connectors: CRM two-way sync w/ field-level contribution controls;
  mailbox/dialer metadata (Phase 6)
- apps: web (search, lists, alerts, plan & usage, admin), extension (MV3 side
  panel: context detect → reveal → badge → save → confirm/deny)

## Extension notes (MV3)
Side panel UI; content script extracts person/company context from the current
page only on user action; auth via the web session; offline-tolerant queue for
confirmations; permissions kept to the minimum host set (IT-review gate, 05).

## Instrumentation (outcome metrics are first-class)
Emit from day one: reveal_latency, reveal_hit/miss, badge_impression,
save_success, bounce_by_confidence_band, job_change_detection_lag,
contribution_effort_ms, contribution_rate_wau, community_activation_rate,
free_to_paid_conversion, canary_catch, erasure_sla.
Dashboards mirror 04's target outcomes one-to-one.
