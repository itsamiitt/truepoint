# ADR-0014 — Trust & certification program (SOC 2 / ISO 27001 / data-broker registration / Trust Center)

- **Status:** Accepted
- **Date:** 2026-06-01
- **Context doc:** [08-compliance.md](../08-compliance.md), [10-roadmap.md](../10-roadmap.md)

## Context

LeadWolf's flagship differentiator is **compliance as a feature** ([00 §1](../00-overview.md),
[08](../08-compliance.md)). The market-gap analysis is blunt that, pre-launch, this is **"a promise, not a
fact"**: no certifications, US-only, and the wedge is cert-dependent
([product-market fit](../../market-analysis/04-product-market-fit.md) §9 — execution
sub-score 35/100; [risk assessment](../../market-analysis/07-risk-assessment.md)).
Two forces make a formal program non-optional:

1. **Buyers' compliance teams gate purchases** on attestations (SOC 2 / ISO 27001), a DPA, and a sub-processor
   list — exactly the audience LeadWolf targets.
2. **Data-broker registration law.** The California **Delete Act / DROP** is live (2026-01-01) with per-day
   penalties, and ~20 US state privacy laws are in force — a business trading in contact data must **register**
   where required ([market research](../../market-analysis/01-market-research.md) §4,
   hidden opening #1).

Recommendations R2 and R6; resolves the SOC2-scope open question ([00 §8.9](../00-overview.md#8-open-questions)).
The single most distinctive opening — *gating the buyer's **own** compliant use end-to-end* (suppression on
reveal **and** send + DSAR fan-out + audit, [08 §3/§4/§6](../08-compliance.md)) — only becomes a **moat** when
it is independently **attested**.

## Decision

Stand up a **Trust & Compliance program** as a parallel, ongoing track ([10](../10-roadmap.md)):

1. **SOC 2 Type II + ISO 27001** — readiness (controls mapped to the self-built auth, RLS isolation, audit-log,
   and encryption design — [03 §9](../03-database-design.md), [08 §5/§9](../08-compliance.md)) beginning at the
   **M5 compliance-hardening** milestone, then external audit.
2. **US data-broker registration** (California DROP/Delete Act and other states as applicable) — a **GA gate**
   in those markets, not optional; tracked in platform compliance ops ([13 §3](../13-platform-admin.md)).
3. **Public Trust Center** — sub-processor list, DPA, security whitepaper, certification status, and links to
   self-serve suppression/DSAR — surfaced in tenant compliance settings ([12 §4](../12-settings.md)).
4. **Attest the wedge** — map the "we govern *your* compliant use end-to-end" claim to the published
   attestations so it is **verifiable**, not asserted.

## Rationale

The analysis is explicit that without certs the differentiator is a promise and the projected fit stays capped
by execution risk; certs + registration convert it to a moat, satisfy the law, and unlock enterprise/EU demand.
The controls largely already exist in the design — the program is mostly **evidence, attestation, and
registration**, not new architecture.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| Formal program: SOC 2 + ISO + registration + Trust Center (this ADR) | Chosen | Only credible path for compliance-sensitive buyers; required by data-broker law |
| Self-attestation / "trust us" only | Rejected | Not credible to the compliance buyers we target; doesn't satisfy registration law |
| Defer certs until post-PMF | Rejected | Certs *are* the wedge; deferring leaves the differentiator unproven exactly when it must win |

## Consequences

- **Positive:** turns the flagship differentiator from promise to moat; satisfies CA DROP / state registration;
  unlocks enterprise + EU expansion; raises the PMF execution sub-score.
- **Negative:** audit cost, lead time, and ongoing control overhead; US-only at first; certification lags GA.
- **Mitigation:** begin **readiness at M5**; treat **registration as a GA gate** (cheaper, faster than audit);
  pursue **certification post-MVP**; publish the Trust Center early even before the audit completes.

## Revisit if

Target segment shifts away from compliance-sensitive buyers, or a specific framework (e.g. EU-specific
certification, HIPAA) becomes the binding requirement instead of SOC 2 / ISO 27001.
