# The Data Flywheel — how more and more data gets collected

Loop: more sellers → more reveals, verifications, corrections, sync exhaust →
fresher graph → measurably better bounce/connect rates (we publish the chart)
→ more sellers; a genuinely useful free tier cuts acquisition cost on top,
and the Community tier ties expanded free access to keeping the network fed. The flywheel
has seven intake channels, ordered by effort-per-datum (C-01 says lower is
better) and gated by the consent model in 09.

## Intake channels
1. **Extension exhaust (passive, user-initiated).** Saves confirm
   person↔company↔role links; reveal-misses map exactly which records the
   market wants but we lack (→ crawl targeting + the most-wanted feed); corrections at
   the moment of pain are the highest-signal data in the system. Never
   background scraping — only actions the user explicitly takes. [C-01, A-01]
2. **Shared verification events.** Any user-run email/phone check writes its
   structured result (status, timestamp, method) to the graph. One user's
   confirm is everyone's freshness. [S-08, S-10]
3. **Micro-confirmations.** One-tap confirm/deny prompts, rate-limited and
   context-timed (post-reveal, post-call). Target ≤5s effort. [C-01, S-09]
4. **CRM two-way sync.** The bulk channel. Value-first framing: we clean and
   enrich THEIR CRM (their job: S-15/S-07); anonymized field-level deltas flow
   back under per-object opt-in + account/domain exclusions. [C-02 controls
   are the adoption gate — see Phase 0 kill test.]
5. **Mailbox/dialer metadata (opt-in, Phase 6).** Bounce events invalidate
   emails; connect dispositions validate numbers. Structured metadata only;
   message content is never read, stored, or transmitted (hard rule, 09).
6. **Platform-side collection (baseline layer).** Licensed seed data for the
   beachhead; public-web crawl of company sites, careers pages, registries,
   filings; pattern inference (email formats) marked as inferred-low-
   confidence until corroborated. This layer exists so day-one reveals succeed
   (Phase 1 kill criterion); it is never the differentiator (S-05 non-goal).
7. **Most-wanted feed.** Reveal-miss demand + low-confidence high-value
   records prioritize which confirm/deny prompts each user sees and where
   crawl/seed effort goes. Demand shapes targeting, not pricing — the asks a
   user sees are exactly the holes the market feels. [S-02, C-01]

## Access model: freemium (data feeds the network, money is the revenue)
Four tiers; no credit, points, or bounty currency anywhere in the system.
- **Free** — monthly reveal cap, extension, search, a small saved list.
  Contribution prompts available, fully voluntary.
- **Community (free)** — expanded caps plus limited job-change alerts,
  unlocked instantly (C-04) and kept while at least one contribution channel
  stays active: CRM sync, mailbox metadata, or a rolling floor of accepted
  confirmations. The status, and exactly what keeps it, is always visible in
  plain language (C-03, C-05).
- **Pro (paid)** — high caps, full alerts, exports, priority verification.
- **Team (paid)** — seats, pooled limits, CRM-sync admin controls, and the
  compliance pack (A-01/A-02 surfaces). Sold to RevOps (Market 3) — turns
  admins into contribution advocates instead of blockers.
Why this design: with no farmable currency there is nothing to farm — A-03
shrinks from economic fraud to data-quality fraud (canaries, reputation,
channel-liveness checks), C-06 gets easier (no clawbacks to litigate), and
pricing is legible in one glance. What we give up: the per-action supply
incentive. Mitigations: contribution-as-exhaust (C-01) was always the primary
supply engine; the Community tier converts supply from a transaction into a
*structural* incentive; the most-wanted feed aims prompts where demand is.
Decision point (see decisions.md): Community-unlock ships ON by default; the
pure-voluntary fallback is documented if Phase 3's kill test fires.

## Quality control (the graph's immune system)
- Corroboration count + source diversity per field; confidence is Bayesian-
  style: prior from source type, updated by events, decayed by per-field
  half-lives (role/title decays fast; company firmographics slowly).
- Ground truth feedback: real bounce/connect outcomes from connected users
  continuously re-calibrate the confidence model — the market grades our data
  and the grade feeds back in.
- Canary records (synthetic honeypots) detect fabrication farms; statistical
  anomaly detection on contribution velocity/agreement patterns; sampled human
  review for high-value fields (dials) before they vest.
- Conflict resolution: freshest-wins, weighted by contributor reputation and
  method strength (SMTP-verified beats pattern-inferred; a departure
  correction corroborated by 3 users beats a year-old crawl).

## Cold start (density before breadth — see 05)
Seed the beachhead heavily (licensed + crawl) so reveal-hit ≥ the Phase 1 bar;
recruit founding contributors from the beachhead's seller communities with
founding-member perks (extended Community caps for life, public founding
status); publish the
bounce-rate-by-confidence chart as marketing the moment it's respectable.
Expand to niche #2 only when niche #1's corroboration density sustains
S-09/S-13 SLAs on its own.
