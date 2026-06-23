# Compliance

Enterprise buyers don't just want secure engineering — they require evidence of a
compliance *program*: SOC 2, often ISO 27001, and adherence to data-protection law
(GDPR, India's DPDP, and others). This file is how compliance obligations land in
day-to-day engineering. It is not legal advice; it is the engineering-facing
discipline that makes the program real. The mechanics it relies on live in
`data-protection.md` (PII, residency, KMS), `access-control.md`/`enterprise-iam.md`
(access, audit), and **truepoint-data** retention-and-deletion.

---

## Compliance Is Built In, Not Bolted On

A program is only credible if the system actually behaves the way the policies claim.
Most controls map to things engineering must build and maintain:

- **Audit trail** — a real, queryable record of who did what to which record, and who
  changed access (see `access-control.md`, `enterprise-iam.md`, **truepoint-data**
  data-model AuditEvent). Auditors and incident responders both depend on it. It
  records IDs and actions, never the personal contents (`data-protection.md`).
- **Access reviews** — the ability to answer "who can access what, and why" and to
  show access is least-privilege and reviewed. This requires roles/permissions to be
  data-driven and inspectable (`enterprise-iam.md`).
- **Change management** — changes are reviewed, tested, and traceable (the
  architecture CI/CD, CODEOWNERS, and PR discipline are the evidence — see
  **truepoint-architecture** cicd and multi-agent). A SOC 2 auditor asks how a change
  reached production; the pipeline is the answer.
- **Encryption and key management** — in transit, at rest, KMS-managed keys with
  rotation (`data-protection.md`).
- **Vendor/sub-processor management** — third parties that process customer data
  (enrichment/verification providers, infra) are tracked, risk-assessed, and listed
  (the sub-processor list customers can request). New integrations that send PII to a
  provider go through this (`integrations.md`).

When building a feature, the question "what evidence would an auditor want that this
control works?" usually points at audit logging, access checks, and tested change
management you should be wiring anyway.

> **Implementation status:** the program is **partially in place, not complete**. The
> schema for the controls exists — an append-only audit log, `dsar_requests` (the
> platform-owned subject-rights workflow, run via the privileged `leadwolf_admin` role —
> `packages/db/src/schema/compliance.ts`, `dsarRepository.ts`), and consent records
> (`consentRepository.ts`) — but a certified SOC 2 / ISO 27001 program, residency
> enforcement, and KMS-managed encryption are **targets** (see `data-protection.md`).
> Keep the mandates; they are the bar these schemas exist to serve.

---

## SOC 2 / ISO 27001 (the engineering surface)

These frameworks certify that controls exist and operate. Engineering's surface:

- **Logging and monitoring** that would detect and evidence an incident (see
  **truepoint-platform** observability) — not just for ops, but as a control.
- **Access control** enforced and reviewable (this skill).
- **Change management** evidenced by the pipeline (architecture).
- **Encryption, backup, and recovery** in place and tested (data-protection,
  **truepoint-platform** data-platform).
- **Incident response** with a defined process and records (see
  **truepoint-operations** incident-response, breach-notification).

The point for an engineer: the controls auditors check are the same disciplines these
skills already require — done consistently and *evidenced*.

---

## GDPR / DPDP (data-protection law)

For a product processing third-party prospect PII, data-protection law is core, not
peripheral:

- **Lawful basis / consent** is tracked, and opt-outs/suppressions respected
  (`data-protection.md`).
- **Data residency** — region-constrained data stays in region (`data-protection.md`,
  **truepoint-platform** tenancy).
- **Data-subject rights** are operable:
  - **Right of access (DSAR)** — provide the data held about a person, via the
    tenant-scoped, access-controlled, rate-limited export path (`data-protection.md`,
    **truepoint-data** retention-and-deletion). The `dsar_requests` workflow is
    platform-owned and run through the privileged `leadwolf_admin` role.
  - **Right to deletion** — find and remove/anonymise a person's data across canonical
    and tenant references (**truepoint-data** retention-and-deletion). This only works
    because identity is resolved and data is referenced not copied — design choices
    that compliance depends on.
  - **Right to rectification / portability** as the regime requires.
- **Records of processing (RoPA)** and **data-processing agreements (DPAs)** with the
  sub-processor list — the documentation side, supported by the vendor tracking above.
- **Breach notification** obligations (GDPR's 72-hour clock) — the response process is
  in **truepoint-operations** breach-notification; the *capability* to assess whose
  data was affected comes from the data model and audit trail.

---

## Per-Tenant and Contractual Variation

Enterprise contracts often impose stricter terms than the baseline — specific
retention periods, residency regions, notification SLAs, audit access. The system is
**configurable per tenant** where required (retention — **truepoint-data**
retention-and-deletion; residency/keys — `data-protection.md`; notification —
**truepoint-operations**). Honour the stricter of legal and contractual obligations.

---

## Checklist

- Is there a real, queryable audit trail (records + access changes) recording IDs and
  actions, not PII?
- Are access reviews possible because roles/permissions are data-driven and
  inspectable, and least-privilege?
- Is change management evidenced by the reviewed/tested pipeline?
- Are encryption, KMS, backup, and tested recovery in place?
- Are sub-processors tracked, risk-assessed, and listed, with PII-sending
  integrations going through that process?
- Are DSAR, deletion, consent, and residency operable — not just documented?
- Are stricter per-tenant/contractual terms (retention, residency, notification)
  configurable and honoured?
