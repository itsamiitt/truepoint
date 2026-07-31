# Roadmap — outcomes → phases → features → acceptance criteria

Rules: every feature is tagged with outcome IDs; acceptance criteria (AC) are
outcome metrics; each phase has instrumentation and a kill/adjust criterion.
Sizing and sequencing within phases is Claude Code's job in plan mode; scope
and order of phases is a human decision logged in decisions.md.

## Phase 0 — Discovery & seed strategy (no product code)
Goal: replace provisional scores with interview data; choose beachhead; secure
seed data. Actions: 8–10 seller interviews using the switch-interview guide
(report Part 5 §6.6, adapted); test C-02 anxiety directly ("would you connect
your CRM if account-level exclusions + anonymization existed?"); test C-01
("would you answer one confirm/deny prompt per day?"); evaluate licensed seed
datasets + public-registry/crawl plan for the beachhead. Deliverables: revised
04, chosen beachhead in 05, decisions.md entries.
KILL/ADJUST: if C-02 fear is unresolvable in interviews → CRM-sync channel
demoted, extension-exhaust channels promoted; if S-04 (dials) matters less
than hypothesized in the beachhead → resequence Phase 6.

## Phase 1 — Core graph + read path + extension reveal  [S-03, S-06, S-10(v0), A-01, A-04(v0)]
The smallest thing a seller pays attention to: find a person, reveal verified
contact info, save it without retyping — with provenance from day one.
- Identity graph: person/company/employment/contact_point + provenance_event
  (event-sourced; see 08). Every seed-data row enters through the same
  provenance pipeline as future contributions. [A-01]
- Search + saved ICP filters (meet-bar). [S-01, S-02]
- Chrome extension (MV3, side panel): detect person/company context on
  user-viewed pages; reveal email; show confidence badge v0 ("last verified
  ⟨n⟩ days ago · ⟨k⟩ sources"). User-initiated only — no background capture.
  [S-03, S-10]
- One-click save to CSV/CRM (one connector) with basic dedupe-on-save. [S-06, S-07]
- Metering: usage events + tier-entitlement stub (Free caps enforced) so the
  freemium tiers switch on cleanly later.
AC samples: reveal ≤3s from click [S-03]; badge visible on 100% of reveals
[S-10]; save round-trip ≤5s, zero retyped fields [S-06].
Instrument: reveal latency, reveal-hit rate, reveal-miss log (fuel for Phase 3
bounties), save success, badge impressions.
KILL/ADJUST: reveal-hit rate <40% in beachhead after seed load → stop; fix
seed strategy before building anything else. Nothing downstream matters if
Locate fails.

## Phase 2 — Verification engine + confidence transparency  [S-08, S-10, A-04]
- Async email verification workers (syntax/MX/SMTP/catch-all classification);
  verification_events feed the confidence engine; per-field decay curves
  (email confidence decays toward "stale" absent fresh events). [S-08, S-10]
- Confidence badge v1: score + recency + corroboration count, shown in app,
  extension, and exports. [S-10]
- Entity-resolution v1: deterministic + fuzzy matching, merge with provenance
  retention. [A-04]
AC: records marked "verified <30d" bounce ≤3% in connected users' real usage
[S-08]; confidence computable for 100% of revealed records [S-10].
Instrument: bounce-rate by confidence band (this chart IS the product's proof).

## Phase 3 — Contributor network v1: corrections + freemium launch  [C-01..C-05, A-03, S-09(v1), S-14(v0)]
- One-tap confirm/deny prompts in the extension at natural moments (post-
  reveal, post-call disposition if dialer connected): "Still at ⟨Company⟩?"
  [C-01, S-09]
- Correction flows: mark departed / wrong number / new role; suggest successor
  free-text. [S-09, S-14]
- Freemium tiers v1: Free caps enforced; Community unlocks instantly while a
  contribution channel stays active (07 §Access model); Pro checkout. [C-03, C-04]
- Most-wanted feed: reveal-miss demand prioritizes which confirm/deny prompts
  each user sees. [S-02, C-01]
- Fraud defense v1: contributor reputation score; canary records; anomaly +
  channel-liveness detection against Community-status gaming. No hard
  penalties for good-faith error — reputation absorbs noise. [A-03, C-06]
- Consent & provenance UX: every contribution flow states what's shared, shows
  it in the contributor's sharing log, links the policy. [C-05, A-01]
AC: median marginal effort per contribution ≤5s [C-01]; ≥25% of weekly-active
free users keep a channel active or make ≥1 confirmation/week [C-01/C-03];
Community unlock applied ≤60s after channel activation [C-04]; fabricated-
canary catch rate ≥95% [A-03]; zero contributor-identifying info exposed on
any record [C-02]; free→paid conversion instrumented from day one.
KILL/ADJUST: Community activation <10% of free WAU after onboarding tuning →
the contribution-for-access thesis is weak; pivot supply toward passive
channels (Phase 4/6) and reconsider a paid-only demand side.

## Phase 4 — CRM sync channel + decay engine  [S-09, S-13, S-14, S-15, S-07, C-02]
- Two-way CRM sync (start with the beachhead's dominant CRM): we clean,
  dedupe, and enrich THEIR records (the contributor's own job); field-level,
  anonymized deltas flow back under explicit controls — per-object opt-in,
  account/domain exclusion lists, "never share" fields. [S-15, S-07, C-02]
- Decay engine + job-change detection: cross-contributor corroboration of
  departures/moves; alerts on saved lists; successor suggestions from the
  graph. [S-09, S-13, S-14]
AC: CRM connect→first cleaned-records report ≤10min [S-15]; job change
detected→alert median ≤7d in beachhead [S-13]; exclusion lists honored with
audited zero leakage [C-02].

## Phase 5 — Compliance hardening = enterprise unlock  [A-01, A-02, S-11, C-05]
- Public opt-out/erasure portal; DSAR workflow automation; erasure = tombstone
  event + graph reprocess + export-suppression, SLA-tracked. [A-02]
- Suppression service enforced at search/reveal/export/API (regional DNC lists
  where applicable). [S-11]
- Lawful-basis registry per source type; audit-trail exports for customers;
  notice workflows where required. [A-01, C-05]
AC: erasure honored across graph + exports ≤72h automated [A-02]; suppressed
records unreachable via any surface, verified by test harness [S-11].

## Phase 6 — Scale loops  [S-04, S-08, C-01]
- Opt-in mailbox metadata integration (bounce/reply signals only — never
  content) as a passive freshness channel. [S-08, C-01]
- Phone program for S-04: HLR/carrier validation, call-disposition exhaust
  from dialer integrations, strict per-geo compliance gating (09). Direct
  dials are the highest-value, highest-sensitivity field — deliberately last.
- Reputation tiers, pooled Team limits, contributor status.
Then: rescore everything (including X-04 intent) with real data; re-plan.
