# Breach Notification

A security incident that affects personal data is not just an engineering problem —
it starts legal clocks and contractual obligations. The response is planned before
it happens, because inventing it during a breach guarantees missed deadlines. This
is the process side; the legal/compliance obligations it satisfies live in
`truepoint-security` compliance and data-protection.

---

## A Breach Starts a Clock

Under GDPR (and similar regimes), a personal-data breach that risks individuals'
rights must be reported to the regulator **without undue delay and within 72 hours**
of becoming aware, and affected individuals notified when the risk is high. India's
DPDP and other regimes have their own obligations. The clock starts at *awareness*,
not at *resolution* — so the determination of "is this a reportable breach?" cannot
wait for the full fix.

This means breach assessment runs **in parallel** with incident mitigation, not
after it.

---

## What Counts as a Breach

A breach is unauthorised access to, disclosure of, or loss of personal data. For
TruePoint, the headline cases:

- **Cross-tenant data exposure** — one org seeing another's data. Always treated as
  a potential breach and a SEV1 (see `incident-response.md`, `truepoint-security`
  access-control). This is the defining risk of a multi-tenant CRM.
- **PII leak** — prospect/customer personal data exposed (through a bug, a misconfig,
  a logging mistake — security data-protection, or a leaked secret — secrets).
- **Credential/secret compromise** that could have enabled data access (security
  secrets).

Not every incident is a breach — an outage with no data exposure isn't. The
assessment determines exposure: what data, whose, how many, what risk.

---

## The Process

1. **Detect and contain** — same as any incident (`incident-response.md`); for a
   breach, containment also means stopping ongoing exposure and preserving evidence.
2. **Assess** — what data, which tenants/individuals, what volume, what risk to
   them. This drives whether and whom to notify. Run this immediately and in
   parallel with the technical fix — the 72-hour clock is running.
3. **Notify per obligation** — regulator within the legal window; affected
   customers/individuals per legal and contractual terms. Enterprise contracts
   often specify *who* and *how fast* — honour the stricter of legal and
   contractual.
4. **Remediate** — fix the cause; rotate anything compromised (security secrets);
   add the guardrail/test that prevents recurrence (e.g. tenant-isolation test —
   platform tenancy).
5. **Document** — a breach record (what happened, assessment, who was notified,
   when, remediation) is itself a compliance artifact (security compliance).

---

## Coordinate Communication

- Breach communication is **coordinated**, not ad-hoc — engineering, security,
  legal, and customer-facing teams align on the message. A premature or inaccurate
  statement creates its own harm.
- The status page (`incident-response.md`) and direct customer notification carry
  different detail; neither exposes information that aids further attack.
- For siloed/enterprise tenants, notification may be individualised per their
  contract and data-residency obligations (security compliance).

---

## Why This Lives in a Skill

Because the 72-hour clock means the *capability* to assess and notify must already
exist when a breach is found — the data model must let you determine *whose* data
was exposed (which is why references-not-copies and identity resolution matter —
see `truepoint-data` data-model), and the audit trail must let you reconstruct what
happened (security data-protection). A breach response designed during the breach
is already late.

---

## Checklist

- Is breach assessment run in parallel with mitigation, on the 72-hour clock from
  awareness?
- Is any suspected cross-tenant exposure treated as a potential breach + SEV1?
- Does the assessment determine data type, affected tenants/individuals, volume,
  and risk?
- Is notification made per the stricter of legal and contractual obligations, with
  coordinated messaging?
- Is anything compromised rotated, and a recurrence guardrail/test added?
- Is a breach record documented as a compliance artifact?
