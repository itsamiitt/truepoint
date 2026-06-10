# departments/02 — SDR

> The inbound/outbound qualifier persona: high-volume prospecting, sequencing, and booking meetings for
> AEs. Framework: [25](../25-departments-teams-workspaces.md).

## 1. Purpose & users
Sales Development Reps qualify inbound + run outbound to book meetings. **Users:** SDRs (persona) + SDR
managers (`manager`/`lead`). `department_type = sdr`.

## 2. Persona & surfaces (6 destinations)
- **Home** → SDR activity dashboard (§3). **Prospect** → high-intent/ICP saved views + segments (`24`).
  **Sequences** → the SDR's primary workspace (multi-step plays). **Inbox** → replies + tasks. **Reports**
  → activity pack.

## 3. Dashboard & KPIs
Calls logged (manual — telephony itself is out of scope, [00 §4](../00-overview.md))/emails sent,
opens/clicks/replies, meetings booked + held, sequence performance, reveal→meeting conversion, daily
activity vs. goal, credit burn vs. **team budget**.

## 4. Workflows & automations (`27`)
- **Auto-enroll** new segment members (high-intent) into the right play.
- **Reply triage**: positive reply → create task + notify AE; OOO → snooze; unsubscribe → suppress (`H5`).
- **Cadence guardrails**: per-day send caps, suppression + deliverability checks (`08 §6`).
- **AI drafting** of first-touch (human-reviewed, `23`/`H19`).

## 5. Permissions, visibility & budgets
SDRs: reveal/sequence on assigned + workspace-visible; managers: reassign + team views. Reveal spend under
**per-team budget**; viewer role for read-only coaches.

## 6. Reporting
Per-SDR leaderboard, funnel (touch→reply→meeting), sequence A/B, speed-to-lead; visibility-scoped,
ClickHouse-backed.

## 7. Collaboration
Manager coaching views, shared play library, Inbox assignment, lead hand-off to AE (Sales, `01`).

## Links
- **Links to:** [25](../25-departments-teams-workspaces.md), [24](../24-advanced-search-exploration-ux.md),
  [27](../27-workflow-automation-engine.md), [23](../23-ai-intelligence-layer.md), [05 §13](../05-features-modules.md),
  [08 §6](../08-compliance.md)
- **Linked from:** [25 §9](../25-departments-teams-workspaces.md), [departments/README](./README.md)
