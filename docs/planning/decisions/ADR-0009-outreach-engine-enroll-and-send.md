# ADR-0009 — Outreach engine: LeadWolf enrolls & sends

- **Status:** Accepted
- **Date:** 2026-05-29
- **Context doc:** [05-features-modules.md](../05-features-modules.md), [09-api-design.md](../09-api-design.md), [08-compliance.md](../08-compliance.md)

## Context

The proposal's `outreach_log` plus the founder decision make LeadWolf an **active outreach actor** — it enrolls contacts into sequences and **sends** messages (email + LinkedIn/Sales-Nav) — not just a mirror of external campaign status. This **overrides** the previously-stated stance that "LeadWolf does not send email at MVP" (it only drafted via AI). It also goes beyond the planned read-only CRM sync.

## Decision

- LeadWolf provides an **outreach engine**: build multi-step sequences, **enroll** contacts, and **send** across channels (email via a sending provider, LinkedIn/Sales-Nav assisted). `outreach_log` tracks per-contact campaign membership and status (`enrolled/active/replied/completed/unsubscribed/bounced`); `activities` records each send/open/click/reply.
- AI outreach **drafting** ([05 §16](../05-features-modules.md)) now feeds this engine (draft → review → send), rather than being export-only.
- This **supersedes the "no email send at MVP" stance** in [00 §4/§5](../00-overview.md) and [05 §16](../05-features-modules.md); those docs are updated to reflect an active sending engine.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| Enroll & send (this ADR) | Chosen | Founder decision; makes LeadWolf a full prospecting workflow, not just a database. |
| Ingest-only mirroring | Rejected | Safer/simpler and preserved the no-send stance, but the founders want LeadWolf to drive outreach. |

## Consequences

- **Positive:** end-to-end prospecting (find → reveal → score → sequence → send) in one product; higher value and stickiness.
- **Negative / obligations (must be designed before launch):**
  - **Sending compliance is now first-class:** CAN-SPAM (US) + GDPR/ePrivacy (EU) consent and unsubscribe handling, physical-address/footer requirements, and honoring opt-outs. The **suppression/Do-Not-Contact list now gates sending**, not just reveals ([08](../08-compliance.md)).
  - **Deliverability infrastructure:** sending domains/DKIM/SPF/DMARC, warm-up, bounce/complaint processing (feeds suppression).
  - **Channel ToS:** LinkedIn/Sales-Navigator automated sending carries ToS/account-risk; assisted (human-in-the-loop) sending is the safer default — flagged as an open question.
  - **New roadmap scope:** a sending/sequencing subsystem + provider integrations (a new milestone — see [10](../10-roadmap.md)).
- **Per-workspace:** sequences, enrollment, and sending are workspace-scoped; sending identities are configured per workspace/user.

## Revisit if
Channel ToS or deliverability risk proves too costly — fall back to ingest-only mirroring (the rejected option) or human-in-the-loop assisted send only.
