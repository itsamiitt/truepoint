# Verification

Enrichment finds data; verification confirms it's usable. A contact dataset full
of invalid emails and dead phone numbers wastes reps' time and damages sending
reputation. Verification is the quality gate on the dataset. It shares the
pipeline's properties — async, externally-dependent, metered, cached — so it
follows the same disciplines as `enrichment-pipeline.md`.

Email verification runs behind the **`emailVerifier` port**
(`packages/core/src/data-health/emailVerifier.ts`), so the concrete provider is
swappable and the verdict shape is fixed by the port, not the provider.

---

## Email Verification

Confirms an email is deliverable, in escalating cost/intrusiveness — stop as soon
as a confident verdict is reached:

- **Syntax** — valid format (cheap, local, always first).
- **Domain / MX** — the domain exists and has mail exchange records. A domain with
  no MX can't receive mail.
- **Mailbox check (SMTP probe)** — confirming the specific mailbox exists, where
  legal and where the provider supports it. This is the most intrusive step and is
  subject to constraints:
  - Many networks/hosts block or throttle outbound SMTP probing; some jurisdictions
    and provider terms restrict it. **Do not assume it's available** — it commonly
    isn't from cloud hosts, and a verification provider is often used instead of
    probing directly.
  - When using a third-party verification provider, the same outbound-safety, key-
    handling, minimum-data, and untrusted-response rules apply (see
    `enrichment-pipeline.md` outbound section and `truepoint-security`
    integrations).
- **Result is a graded verdict**, not just true/false — the `emailStatus` enum:
  `unverified` | `valid` | `risky` | `invalid` | `catch_all` (accept-all domains
  where the mailbox can't be confirmed) | `unknown`. The UI and sending logic treat
  `risky`/`catch_all`/`unknown` differently from `valid` — don't collapse the
  grades.

A "valid" verdict has a **freshness** — emails decay as people change jobs — so
verification, like enrichment, has a TTL after which a re-verify is warranted.

---

## Phone Verification

Confirms a number is real and reachable, and classifies it:

- **Format / normalisation** — parse to a canonical international form (E.164),
  rejecting malformed numbers. Shared, deterministic normalisation (same number →
  same canonical form) so dedup keys match (see `enrichment-pipeline.md`).
- **Line type / reachability (HLR-style lookup)** — whether the number is live and
  whether it's mobile vs landline vs VoIP. Line type matters for both deliverability
  and compliance (texting a landline, calling certain line types).
- **Result is graded** — valid/mobile, valid/landline, invalid, unknown — and
  carries provenance.

Phone data feeds the dialer, which carries its own **compliance** obligations —
DNC/TCPA scrubbing, consent, line-type rules — that are not optional and are
covered in `truepoint-security` abuse-and-edge. Verification establishes the number
is real; compliance decides whether you may contact it. Both gate a call.

---

## Shared Pipeline Properties

Verification reuses the enrichment pipeline's machinery:

- **Async** — runs as a job (especially in bulk), never blocking a request (see
  platform async-jobs).
- **Cached with freshness** — a recent verdict is reused, not re-paid (platform
  caching; operations FinOps).
- **Metered and quota'd** — verification calls cost money; per-tenant quotas, rate
  limits, and UsageEvents apply (security api-security; operations FinOps).
- **Idempotent** — a redelivered verification job returns the cached verdict.
- **Provenance-tracked** — every verdict records source, time, and confidence, and
  feeds the field-level merge (enrichment-pipeline.md).

---

## How Verdicts Are Used

- A record's contactability is a function of its verification grades — surfaced to
  users (a "verified" indicator) and usable as a search facet (see
  `search-infrastructure.md`).
- Sending/dialing logic respects the grade: don't blast a "risky" email the same
  as a "valid" one; don't dial an unverified or DNC-flagged number.
- Bulk operations (export, campaign add) can filter by verification status so reps
  work from clean data.

---

## Checklist

- Does email verification escalate syntax → MX → mailbox, stopping at a confident
  verdict, and return a graded `emailStatus`
  (`unverified`/`valid`/`risky`/`invalid`/`catch_all`/`unknown`) via the
  `emailVerifier` port?
- Is SMTP-probe availability not assumed (cloud/host/jurisdiction constraints), with
  a provider used where appropriate under outbound-safety rules?
- Is phone normalised to E.164, line-type classified, and graded?
- Do phone verdicts feed into — and never bypass — DNC/TCPA compliance (security
  abuse-and-edge)?
- Is verification async, cached-with-freshness, metered/quota'd, idempotent, and
  provenance-tracked like enrichment?
- Do downstream send/dial paths respect the grade rather than treating all as valid?
