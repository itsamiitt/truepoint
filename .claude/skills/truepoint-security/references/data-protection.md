# Data Protection

TruePoint stores personal data: the names, emails, phone numbers, job titles, and
locations of customers and their prospects, plus company and deal data. Some
prospects are in jurisdictions with strict data laws (the EU, the UK). Handling
this data carelessly is both a security risk and a compliance one. This file is
about treating that data with the care it requires.

---

## Know What Is PII

Personal data in TruePoint includes, at minimum: names, email addresses, phone
numbers, job titles, physical/location data, and any free-text that might contain
personal details (notes, activity logs). Company-level data and deal values are
sensitive business data even when not personal.

Treat all of it as data that must not leak, must not be logged carelessly, and
must be removable on request. When in doubt about whether a field is sensitive,
treat it as sensitive.

---

## Never Log PII, Tokens, or Secrets

Logs are aggregated, retained, shipped to monitoring services, and read by many
people. They are not a safe place for personal data or credentials.

- **Never log** full request bodies (they contain PII), auth tokens, API keys,
  passwords, or session identifiers.
- **Never log** a prospect's or customer's personal fields to debug something —
  log an ID and the shape of the problem, not the data itself.
- Structured logging carries only what is needed: an event name, a record ID, the
  actor's user ID, a status. Not the record's contents.

```ts
// ❌ leaks PII into the logs
logger.info('updating prospect', { prospect })

// ✅ logs the fact, not the personal data
logger.info('prospect.updated', { prospectId: prospect.id, actorId: session.userId })
```

This includes error logs — an exception that dumps the request body or the
offending record into the log leaks PII at exactly the moment something is going
wrong and logs are most scrutinised.

> **Implementation status:** the `audit_log` is append-only (enforced by DB triggers),
> which is good. But a **logging-layer PII-redaction filter is unverified** — there is
> no confirmed central redactor guaranteeing request bodies / personal fields never
> reach the app logs. The mandate stands; verify (or add) log redaction before relying
> on it.

---

## Encryption

- **In transit**: everything is HTTPS/TLS. No plaintext HTTP for any request
  carrying data or credentials. This is a baseline, not an option.
- **At rest**: the database and backups are encrypted at rest (verify it holds for
  any new data store you introduce).
- **Keys are managed in a KMS.** Encryption keys are not hardcoded or stored beside
  the data — they live in a Key Management Service with **envelope encryption** (a
  master key encrypts per-data data-keys) and **rotation**. A key that never rotates
  and lives next to its ciphertext is not protection.
- **Field-level encryption** for particularly sensitive fields (anything damaging on
  its own) beyond the database default — encrypted with KMS-managed keys, decrypted
  only server-side at point of use, never logged. Design this in when modelling such
  a field, not after.
- **Customer-managed keys (BYOK)** for enterprise tenants who require control of
  their encryption keys — supported via the siloed-cluster model (see
  **truepoint-platform** tenancy), where a tenant's data is encrypted with their key.

> **Implementation status:** these are the **target**. Today PII is encrypted at the
> **application layer** with AES-GCM (`bytea` ciphertext) plus an HMAC blind index for
> per-workspace lookup/uniqueness — e.g. `emailEnc` / `emailBlindIndex` in
> `packages/db/src/schema/contacts.ts` (~lines 106–107). There is **no KMS**, **no
> envelope encryption**, and **no evidence of key rotation**; the encryption key is an
> application secret, not a KMS-wrapped data key. The mandate stands — wire a KMS with
> envelope encryption and rotation when key management is built.

---

## Data Residency

Some data is legally required to stay in a particular region — EU prospect PII under
GDPR being the headline case. Residency is an architectural obligation, not a
toggle:

- **Region-constrained tenants are siloed** to a cluster in the required region (see
  **truepoint-platform** tenancy and data-platform). Their data — primary, replicas,
  backups, and search index — stays within that region; cross-region replication
  respects the constraint.
- **Outbound data flows honour residency** — what's sent to an enrichment/verification
  provider, and where that provider processes it, has residency implications for EU
  PII (see `integrations.md`, **truepoint-data** enrichment-pipeline). Raise it when
  designing any integration that ships EU PII to a third party.
- **Residency is distinct from localization** — which *region* the data lives in
  (here) vs which *language* the UI uses (design i18n). Don't conflate them.

The compliance program (see `compliance.md`) defines which tenants/data are
residency-constrained; this is the enforcement.

> **Implementation status:** the **target**. Today all tenants share a single Postgres
> instance — there is **no region-pinning / siloed-cluster model**, and **no BYOK**.
> Residency is therefore not yet enforceable for region-constrained tenants. Keep the
> mandate as the bar; region-pinning and per-tenant key control are future work in the
> tenancy/data-platform layer.

---

## Consent and Lawful Basis

Processing prospect PII — especially under GDPR/DPDP — requires a lawful basis, and
individuals have rights over their data:

- **Lawful basis / consent is tracked** where the regime requires it, so processing
  can be justified and a withdrawal honoured. For a tool whose whole job is
  processing third-party prospect PII, "why are we allowed to hold this?" must have
  an answer.
- **Suppression / do-not-contact and opt-outs are respected** across the system — a
  prospect who opts out is suppressed from outreach (this overlaps telephony DNC —
  see `abuse-and-edge.md`).
- **Consent and basis records feed deletion/DSAR** — see Retention and Deletion below
  and **truepoint-data** retention-and-deletion. The compliance program
  (`compliance.md`) owns the policy; the data model and these mechanics enforce it.

---

## Data Minimization

Collect, fetch, store, and return only the data the task actually needs.

- Don't `SELECT *` and ship the whole row to the client when the UI needs three
  fields — fetch and return only those fields (see field exposure below).
- Don't store data you don't need. Every extra field of PII is extra liability.
- Don't pass full records between systems when an ID would do.

Less data held is less data to leak, less to log by accident, and less to delete
later.

---

## Field-Level Exposure

The API returns only the fields the caller is authorised to see. A record in the
database often has fields the client should never receive — internal flags, other
users' data, server-only metadata.

- Map database records to a response shape that contains only client-appropriate
  fields. Never return the raw database row.
- A staff user viewing a prospect should not receive fields meant only for admins
  or fields belonging to the internal scoring pipeline.
- Be especially careful with related data — fetching a list and its members should
  not accidentally include each member's full internal record.

See `api-security.md` for the response-shaping discipline in full.

---

## Retention and Deletion

Personal data is not kept forever, and individuals can request its deletion.

- **Deletion must be real and complete.** When a record is deleted, its related
  data (activity, notes, list memberships, audit references to its content) is
  handled per policy — cascade-deleted or anonymised, not left as orphaned PII.
  This mirrors the architecture skill's removal-cleanup discipline, applied to data.
- **Right to deletion**: the system must be able to remove an individual's
  personal data on request. Design models so a person's data can be found and
  removed, not scattered untraceably.
- **Audit logs are an exception to log-nothing-personal but must still be
  careful**: an audit trail records *who did what to which record* (IDs and
  actions) — it should not duplicate the personal contents of the record. An audit
  entry says "user X updated prospect 123," not "user X changed the email to
  jane@example.com."

---

## Data Export (DSAR)

The export feature (see the architecture dependency-wiring skill) doubles as a
data-subject-access mechanism — a person or org can obtain the data held about
them. This means exports must themselves be access-controlled and tenant-scoped:
an export endpoint that isn't scoped is a bulk data-leak in one call. Rate-limit
exports and scope them to the requester's org.

---

## Checklist

- Is any PII, token, or secret being written to logs (including error logs)? (it shouldn't be)
- Is all data transmitted over TLS?
- Does the query fetch only the fields needed, not `SELECT *`?
- Does the API response contain only client-appropriate fields, not the raw row?
- Can this person's data be found and deleted on request?
- Does deletion handle related data, leaving no orphaned PII?
- Do audit entries record IDs and actions, not the personal contents?
- Is the export endpoint tenant-scoped and rate-limited?
- Are encryption keys KMS-managed with envelope encryption and rotation (and BYOK for
  enterprise tenants that require it)?
- Is residency-constrained data (e.g. EU PII) kept in-region across primary,
  replicas, backups, and index — including outbound provider flows?
- Is lawful basis/consent tracked where required, and are opt-out/do-not-contact
  suppressions respected system-wide?
