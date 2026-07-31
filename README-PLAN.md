# Sales Intelligence Platform + Data Contributor Network
## JTBD/ODI Planning Pack — ready for Claude Code

This folder is a drop-in strategy layer for your repository. Copy everything to
your project root (merge `CLAUDE.md` with any existing one), open Claude Code,
enter plan mode (Shift+Tab until the footer shows plan mode), and paste the
contents of `KICKOFF-PROMPT.md`. Claude will read this strategy, inspect your
existing system, and propose a Phase 1 implementation plan for your approval.

## The strategy in one page

**The reframe that everything else follows from.** Nobody has a job called
"contribute data." A contributor network designed as a chore (fill in forms,
donate your address book) fights human nature and loses. The network must be
designed as *exhaust*: data that falls out of jobs your users are already
desperately trying to get done — verifying a contact before wasting a dial,
keeping their CRM from rotting, getting access without a five-figure contract.
Every contribution channel in this plan is attached to a job the contributor
already has. That is the entire design philosophy (outcome C-01).

**Why the network is the strategy, not a feature.** The provisional opportunity
scores (04) tell one story loudly: this market's pain is concentrated in
*freshness and decay* — people who changed jobs (S-09, 14.0), unreachable
direct dials (S-04, 13.7), silent record rot (S-13, 13.6), bounces (S-08,
13.5), and no way to know how trustworthy a record is (S-10, 13.2). Meanwhile
the thing incumbents compete on — raw database size — is the most overserved
outcome on the board (S-05, 4.5). Static crawling cannot win the freshness
cluster; only millions of daily human touchpoints can. The contributor network
is the *only mechanism* that wins the underserved cluster. Build accordingly.

**The Chrome extension is a double agent.** On the demand side it serves the
in-context job (reveal, save-to-CRM, confidence badge while the rep is on
LinkedIn or a company site). On the supply side it is the highest-volume,
lowest-friction contribution surface: one-tap confirm/deny prompts, corrections
at the moment of discovery, and reveal-misses that feed the most-wanted feed.
Every extension interaction either consumes freshness or produces it.

**The flywheel.** More sellers → more reveals, verifications, corrections, and
CRM/mailbox exhaust → fresher graph → measurably better bounce and connect
rates → more sellers (a genuinely useful free tier cuts acquisition cost, and
the Community tier ties expanded free access to keeping the network fed).
Fraud defense (A-03) and contributor anonymity (C-02) are load-bearing walls
of this flywheel, not nice-to-haves — a contributor network dies of junk data
or of reps fearing they're leaking their book of business.

**Compliance is a wedge, not a tax.** Provenance on every field, opt-out
handling, and suppression enforcement (A-01, A-02, S-11) are what let you sell
upmarket — and they're far cheaper to build into the event-sourced core now
(08-architecture) than to retrofit.

## What's in this pack

| File | Purpose |
|---|---|
| `CLAUDE.md` | The standing contract Claude Code reads every session |
| `KICKOFF-PROMPT.md` | The exact first prompt to paste into plan mode |
| `docs/strategy/01-job-statement.md` | Three markets: seller, contributor, revops/admin |
| `docs/strategy/02-job-map.md` | Seller job map + the contribution-exhaust column |
| `docs/strategy/03-outcomes.md` | ~30 desired outcomes in ODI syntax (S-/C-/A- tracks) |
| `docs/strategy/04-opportunity-scores.md` | Provisional scores, bands, explicit non-goals |
| `docs/strategy/05-segments.md` | Beachhead logic: density beats breadth |
| `docs/strategy/06-roadmap.md` | 6 phases, every feature tagged to outcome IDs |
| `docs/strategy/07-data-flywheel.md` | All collection channels, freemium access model, fraud defense |
| `docs/strategy/08-architecture.md` | Services, data model, extension design for Claude Code |
| `docs/strategy/09-compliance.md` | Legal guardrails expressed as product requirements |
| `docs/strategy/decisions.md` | Dated log — starts with the founding assumptions |

## Before you build (the honest part)

All scores in 04 are **hypotheses** — my provisional estimates from market
knowledge, not your customers' data. Phase 0 of the roadmap exists to let 8–10
real interviews embarrass them cheaply. Three assumptions deserve the harshest testing: that contributors will
connect a CRM if anonymity controls are strong (C-02), that confirm/deny
micro-prompts get real engagement (C-01), and that the Community tier's
expanded access motivates keeping a channel active (C-03). If any fails, the
flywheel design changes materially — better to learn that in
week two than month six.
