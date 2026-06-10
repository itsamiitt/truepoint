# 15 — Gap Remediation Plan

> Translates the **market-gap analysis** ([../market-analysis/](../market-analysis/)) into concrete planning
> decisions and wires them into the corpus. It maps **all 16 market gaps**, the **6 hidden opportunities**, and
> the **ranked recommendations R1–R11** to a remediation, an ADR (where a decision was made), a milestone, and a
> status. Like [14 — Phase 1 Execution](./14-phase-1-execution.md), this is an **overlay**: it does not invent
> milestone scope beyond what is wired into [05 §21](./05-features-modules.md#21-feature--milestone-matrix) and
> [10](./10-roadmap.md); it records *what we changed and why*.

> **Source:** [../market-analysis/03-market-gaps.md](../market-analysis/03-market-gaps.md) (16 gaps + §10 hidden
> opportunities) and [../market-analysis/09-executive-report.md](../market-analysis/09-executive-report.md)
> (recommendations + projected PMF 62/100). The analysis grades LeadWolf **pre-launch** — these remediations are
> design decisions, not validated outcomes.

## 1. How to read this

For each gap we record:

- **Status** — how the *existing* plan already stood: **✅ covered** (no change needed), **🔶 partial/deferred**
  (covered later or incompletely), or **⚪ open** (not yet a documented capability).
- **Remediation** — the change this plan makes (or an affirmation that the plan already suffices).
- **Decision** — the ADR/section that now records it.
- **Milestone** — when it lands ([10](./10-roadmap.md)).

The honest headline: **most gaps were already covered** by the existing design (scoring, isolation, lean UX,
end-to-end loop, in-transaction compliance gating). The remediation concentrates on the **open / partial**
gaps and the **highest-ranked recommendations** via three new decisions —
[ADR-0012](./decisions/ADR-0012-transparent-no-lock-in-commercial-policy.md) (commercial policy),
[ADR-0013](./decisions/ADR-0013-charge-for-verified-data-credit-back.md) (charge/credit-back), and
[ADR-0014](./decisions/ADR-0014-trust-and-certification-program.md) (trust & certification).

## 2. Gap remediation matrix (the 16 gaps)

| Gap | Status before | Remediation | Decision | Milestone |
|---|---|---|---|---|
| **2.1** Verified-on-reveal + accuracy SLA | 🔶 partial (no owned data) | Charge **only for `valid`** data; **credit-back-on-bounce** guarantee; honest `email_status` surfacing | [ADR-0013](./decisions/ADR-0013-charge-for-verified-data-credit-back.md), [07 §3](./07-billing-credits.md), [06 §9](./06-enrichment-engine.md) | M3/M4 (guarantee matures with send feedback M9) |
| **2.2** Compliant cold-send that lands | 🔶 M9 | Affirmed; deliverability hardened as first-class (below, 6.2) | [ADR-0009](./decisions/ADR-0009-outreach-engine-enroll-and-send.md), [08 §6](./08-compliance.md) | M9 |
| **2.3** Versioned lead scoring | ✅ covered | No change — model M4, UI M8 | [ADR-0008](./decisions/ADR-0008-lead-scoring-model.md) | M4/M8 |
| **3.1** Tool-sprawl / consolidation | 🔶 full loop M9 | Affirmed — end-to-end find→reveal→score→send is the thesis | [ADR-0009](./decisions/ADR-0009-outreach-engine-enroll-and-send.md) | M1–M9 |
| **3.2** Repeatable prospecting vs DIY | ✅ covered | Affirmed; seat priced to undercut the VA/Sales-Nav baseline | [ADR-0012](./decisions/ADR-0012-transparent-no-lock-in-commercial-policy.md) | MVP |
| **3.3** Agency / multi-brand isolation | ✅ covered | No change — per-workspace RLS isolation | [ADR-0006](./decisions/ADR-0006-per-workspace-multitenant-model.md) | M2 |
| **4.1** Lean UX / fast time-to-value | ✅ covered | No change — single-page command center by design | [04](./04-ui-ux-design.md), [11](./11-information-architecture.md) | by design |
| **4.2** Credit anxiety as UX | ✅ covered | Reinforced by charge-by-status + credit-back (you see cost, pay only for valid) | [ADR-0013](./decisions/ADR-0013-charge-for-verified-data-credit-back.md), [04 §5](./04-ui-ux-design.md) | M3 |
| **5.1** Transparent self-serve pricing | 🔶 intended | Committed as policy (prices still placeholder) | [ADR-0012](./decisions/ADR-0012-transparent-no-lock-in-commercial-policy.md), [07 §1A](./07-billing-credits.md) | M3 |
| **5.2** No auto-renewal / data-destroy lock-in | 🔶 intended | Committed: month-to-month default, no traps, **export-on-exit, no data-destroy** | [ADR-0012](./decisions/ADR-0012-transparent-no-lock-in-commercial-policy.md), [12 §4](./12-settings.md) | M3 |
| **5.3** Predictable cost vs consumption fatigue | ✅ covered | Reinforced: credits don't expire (MVP); charge-only-for-valid | [ADR-0012](./decisions/ADR-0012-transparent-no-lock-in-commercial-policy.md), [ADR-0013](./decisions/ADR-0013-charge-for-verified-data-credit-back.md) | M3 |
| **6.1** CRM-agnostic / open API | 🔶 M10 | Affirmed as the **anti-absorption** position (CRM-neutral, API-first) | [09 §8](./09-api-design.md), [10 M10](./10-roadmap.md) | M10 |
| **6.2** Deliverability & sender-reputation discipline | 🔶 M9 | Hardened to a **first-class subsystem** (domains, DKIM/SPF/DMARC, warm-up, throttle, bounce→suppression) | [08 §6](./08-compliance.md), [10 M9](./10-roadmap.md) | M9 |
| **6.3** In-transaction compliance gating reveal **and** send | ✅ covered (send half M9) | Affirmed as the flagship moat; made **verifiable** via certs | [ADR-0009](./decisions/ADR-0009-outreach-engine-enroll-and-send.md), [ADR-0014](./decisions/ADR-0014-trust-and-certification-program.md), [08 §3](./08-compliance.md) | M5 reveal / M9 send |
| **7.1** Responsive post-sale support | ⚪ open | **Documented service commitment** (§4) + tier SLA + in-app support surface | [§4 below](#4-post-sale-support--success), [12 §6](./12-settings.md), [13 §3](./13-platform-admin.md) | M3→ |
| **7.2** Honest, auditable metrics & data-handling | 🔶 partial | **Trust Center** + published attestations + append-only audit | [ADR-0014](./decisions/ADR-0014-trust-and-certification-program.md), [08 §15](./08-compliance.md) | M5 → program |

## 3. Hidden-opportunity remediation (analysis §10)

| # | Hidden opening | Remediation | Decision |
|---|---|---|---|
| 1 | **Gate the buyer's *own* outbound** (not just clean source data) | Affirm + **attest** the suppression-gates-reveal-**and**-send + DSAR-fan-out + audit wedge | [ADR-0014](./decisions/ADR-0014-trust-and-certification-program.md), [08 §3/§4/§6](./08-compliance.md) |
| 2 | **Anti-lock-in / data-ownership brand** | Committed no-data-destroy + export-on-exit policy | [ADR-0012](./decisions/ADR-0012-transparent-no-lock-in-commercial-policy.md) |
| 3 | **Don't-charge-for-bad-data guarantee** | Charge-only-for-`valid` + credit-back-on-bounce | [ADR-0013](./decisions/ADR-0013-charge-for-verified-data-credit-back.md) |
| 4 | **"Augmented human, not autonomous slop"** | Position human-in-the-loop as a strength; match AI research/drafting horsepower | [05 §16](./05-features-modules.md), [ADR-0009](./decisions/ADR-0009-outreach-engine-enroll-and-send.md) |
| 5 | **Orphaned ex-Clearbit / API-first audience** | CRM-neutral public API as a low-noise acquisition channel | [09 §8](./09-api-design.md), [10 M10](./10-roadmap.md) |
| 6 | **The DIY-baseline buyer** (vs named-competitor switcher) | Price a usable seat below the VA/Sales-Nav baseline | [ADR-0012](./decisions/ADR-0012-transparent-no-lock-in-commercial-policy.md) |

## 4. Post-sale support & success *(gap 7.1 — newly documented)*

Support was an **⚪ open** GTM/ops commitment, absent from the corpus. It is now documented (no architecture
change; uses existing surfaces):

- **In-app support surface** — help/contact entry from the app shell ([11](./11-information-architecture.md));
  notifications cover DSAR/billing/import events ([05 §20](./05-features-modules.md)).
- **Tiered SLA** — priority support is an **Enterprise** entitlement; the tier matrix already lists
  *SLA / priority support* ([12 §6](./12-settings.md)).
- **Staff-side tooling** — support staff use the audited **impersonation + customer-360 + support notes** in the
  admin console ([13 §3](./13-platform-admin.md), [ADR-0011](./decisions/ADR-0011-platform-admin-and-privileged-access.md)).
- **Trust as support** — the self-serve **Trust Center** + suppression/DSAR intake deflect compliance tickets
  ([ADR-0014](./decisions/ADR-0014-trust-and-certification-program.md), [12 §4](./12-settings.md)).

> **Open:** response-time SLAs by tier and a help-center/ticketing tool choice are GTM decisions
> ([§ open questions](#open-questions)).

## 5. Recommendations R1–R11 → where addressed

| # | Recommendation | Addressed by |
|---|---|---|
| R1 | Honest, no-lock-in billing | [ADR-0012](./decisions/ADR-0012-transparent-no-lock-in-commercial-policy.md), [07 §1A](./07-billing-credits.md) |
| R2 | Compliance as a buying gate | [ADR-0014](./decisions/ADR-0014-trust-and-certification-program.md), [08 §15](./08-compliance.md) |
| R3 | Verified-on-reveal + credit-back | [ADR-0013](./decisions/ADR-0013-charge-for-verified-data-credit-back.md), [07 §3](./07-billing-credits.md) |
| R4 | Target SMB/mid-market & agencies (isolation) | [ADR-0006](./decisions/ADR-0006-per-workspace-multitenant-model.md) (existing) |
| R5 | DIY-stack replacement positioning | [ADR-0012](./decisions/ADR-0012-transparent-no-lock-in-commercial-policy.md), [brand-identity.md](./brand-identity.md) |
| R6 | Compliance certifications (SOC 2 / ISO / registration) | [ADR-0014](./decisions/ADR-0014-trust-and-certification-program.md), [10 Trust track](./10-roadmap.md) |
| R7 | Compliant send + deliverability engine | [08 §6](./08-compliance.md), [10 M9](./10-roadmap.md) (existing, hardened) |
| R8 | CRM-neutral sync + public API | [09 §8](./09-api-design.md), [10 M10](./10-roadmap.md) (existing, affirmed) |
| R9 | Scoring depth + activity timeline + reports | [ADR-0008](./decisions/ADR-0008-lead-scoring-model.md), [10 M8](./10-roadmap.md) (existing) |
| R10 | Augmented-human AI line | [05 §16](./05-features-modules.md) (existing, positioned) |
| R11 | Enterprise governance (SSO/SCIM/residency) | [10 M11](./10-roadmap.md) (existing) |

## 6. What changed in the corpus

- **New ADRs:** [ADR-0012](./decisions/ADR-0012-transparent-no-lock-in-commercial-policy.md),
  [ADR-0013](./decisions/ADR-0013-charge-for-verified-data-credit-back.md),
  [ADR-0014](./decisions/ADR-0014-trust-and-certification-program.md) (+ decision-log rows in
  [00 §7](./00-overview.md#7-decision-log)).
- **[07](./07-billing-credits.md):** new commercial-policy section (§1A) + charge-by-status in the reveal
  transaction (§3); resolved charge-policy open question.
- **[08](./08-compliance.md):** new certifications/Trust-Center section (§15) + deliverability depth (§6) +
  `credit.adjust` added to the closed audit-action enum (§5).
- **[06](./06-enrichment-engine.md):** verification now drives the charge decision (§9).
- **[09](./09-api-design.md):** reveal response reflects charge-by-status (§3.2) + CRM-neutral API positioning (§8).
- **[05](./05-features-modules.md):** reveal/credits/AI module notes + matrix row for the Trust & Compliance track.
- **[03](./03-database-design.md):** credit-back via audited counter adjustment + audit enum note (§8).
- **[10](./10-roadmap.md):** Trust & Compliance program track + M9 deliverability DoD + risk rows 13–16.
- **[12](./12-settings.md):** Trust Center + data export-on-exit/account-closure + support.
- **[13](./13-platform-admin.md):** certification & data-broker-registration tracking in compliance ops.
- **[00 §8](./00-overview.md#8-open-questions):** resolved pricing-policy (partial) and SOC2-scope questions.

**Enterprise-extension pass (2026-06-10)** — a full-corpus audit added scale/AI/department depth:
- **New docs** [18](./18-scalability-performance.md)–[27](./27-workflow-automation-engine.md) +
  [departments/](./departments/) (11 modules); **new ADRs**
  [ADR-0022](./decisions/ADR-0022-departments-teams-intra-workspace-segmentation.md)–[ADR-0027](./decisions/ADR-0027-real-time-delivery-and-event-backbone.md);
  **roadmap** milestones **M12–M16** + risks #18–22 ([10](./10-roadmap.md)).
- **Gaps closed:** scale/SRE depth + event/real-time backbone; the **AI intelligence layer**;
  freshness/coverage SLAs; **department/team workspaces**; advanced search UX; governance controls
  (role-gating, per-team budgets, export caps); integrations breadth; the automation engine.
- **New differentiators:** AI research-agent + **signal-to-play**, conversational **copilot**, **freshness
  guarantees**, **lawful-basis lineage** ("provenance you can show an auditor"), no-lock-in **reverse-ETL**,
  department/manager **performance intelligence**, deliverability cockpit, Chrome-extension + SMS.

## Links
- **Links to:** [00](./00-overview.md), [03](./03-database-design.md), [05](./05-features-modules.md),
  [06](./06-enrichment-engine.md), [07](./07-billing-credits.md), [08](./08-compliance.md),
  [09](./09-api-design.md), [10](./10-roadmap.md), [12](./12-settings.md), [13](./13-platform-admin.md);
  [ADR-0012](./decisions/ADR-0012-transparent-no-lock-in-commercial-policy.md),
  [ADR-0013](./decisions/ADR-0013-charge-for-verified-data-credit-back.md),
  [ADR-0014](./decisions/ADR-0014-trust-and-certification-program.md); the analysis under
  [../market-analysis/](../market-analysis/).
- **Linked from:** [README](./README.md), [00 §7](./00-overview.md#7-decision-log), [10](./10-roadmap.md).

## Open questions
1. **Response-time SLAs by tier** and a help-center/ticketing tool choice (GTM/ops — gap 7.1).
2. **Credit-back guarantee window** length and `risky`-email charge default (placeholders —
   [07 §1](./07-billing-credits.md), [ADR-0013](./decisions/ADR-0013-charge-for-verified-data-credit-back.md)).
3. **Certification sequencing** — SOC 2 Type II vs ISO 27001 first; which state data-broker registrations are
   GA-blocking ([ADR-0014](./decisions/ADR-0014-trust-and-certification-program.md)).
