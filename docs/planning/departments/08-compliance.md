# departments/08 — Compliance

> The governance persona that **keeps usage lawful**: suppression, consent, DSAR intake/tracking, audit
> review, and data-broker obligations. Surfaces the controls in [08](../08-compliance.md).
> Framework: [25](../25-departments-teams-workspaces.md).

## 1. Purpose & users
Compliance officers manage lawful basis, suppression/DNC, consent records, DSARs, and audit oversight.
**Users:** Compliance/Legal/DPO. `department_type = compliance`. (Buyer-side governance of platform usage.)

## 2. Persona & surfaces (6 destinations)
- **Home** → compliance dashboard (§3). **Settings** → suppression lists, consent, retention/freshness
  policy, DSAR intake (`12`, `08`). **Reports** → audit-log viewer + DSAR tracker. Read-broad,
  PII-minimized.

## 3. Dashboard & KPIs
Open DSARs vs. SLA, suppression coverage, consent records by jurisdiction, audit anomalies, retention/purge
queue (`22 §7`), data-broker registration status + DROP deletions (`08 §4.4`).

## 4. Workflows & automations (`27`)
- **DSAR pipeline**: intake → fan-out delete/access/rectify across copies (`H6`) → verify → close.
- **Suppression sync**: bounce/unsubscribe/opt-out → suppression (`H5`), gating reveal **and** send.
- **Consent capture/expiry** tracking; **lawful-basis lineage** review (`21 §5`).
- **Anomaly alerts** on audit events (`08 §5`).

## 5. Permissions, visibility & budgets
Compliance: manage suppression/consent/DSAR + read audit; can set records/areas to `visibility=team/owner`
(`H18`); no reveal budget needed. Acts with workspace-admin + (for cross-tenant) staff compliance role
(`13 §2`).

## 6. Reporting
DSAR SLA, suppression/consent coverage, audit review, retention compliance, certification posture
(`08 §15`); exportable for auditors ("provenance you can show an auditor", `15`).

## 7. Collaboration
Partners with RevOps (data policy), Finance (retention cost), Admin (access reviews); escalation path to
platform staff compliance (`13`).

## Links
- **Links to:** [25](../25-departments-teams-workspaces.md), [08 §3/§4/§5/§15](../08-compliance.md),
  [22 §7](../22-data-quality-freshness-lifecycle.md), [21 §5](../21-data-acquisition-sourcing.md), [12 §4](../12-settings.md),
  [27](../27-workflow-automation-engine.md), [13 §2](../13-platform-admin.md)
- **Linked from:** [25 §9](../25-departments-teams-workspaces.md), [departments/README](./README.md)
