# Retention and Deletion

TruePoint holds personal data, and personal data is not kept forever — it ages out
by policy and individuals can demand its removal. Deletion in a system with a
canonical dataset, per-tenant working records, an index, caches, backups, and audit
logs is not a single `DELETE` — it's a coordinated operation. This file is how
deletion is done so no orphaned PII is left behind. It is the data mechanics behind
the compliance obligations in `truepoint-security` compliance and data-protection,
and the data mirror of the architecture removal-cleanup discipline.

---

## Deletion Must Be Real and Complete

When a record is deleted, every place its personal data lives is handled — or the
deletion is a lie that leaves PII scattered:

- **The record** in Postgres (source of truth).
- **Dependent tenant data** — its activity, notes, list memberships, tasks, deals'
  reference to it — cascade-deleted or anonymised per policy, not left as orphans
  pointing at a deleted record.
- **The search index** — de-indexed, so it stops appearing in results (see
  `search-infrastructure.md`).
- **Caches** — invalidated, so a cached copy doesn't survive the delete (see
  platform caching).
- **Backups** — covered by the backup retention window: a deleted record may
  persist in backups until they age out; this is expected and is part of the
  documented retention policy, not an indefinite shadow copy.
- **Audit log** — kept (it's the record *that* something happened), but it holds
  IDs and actions, not the personal contents (see below and security
  data-protection), so retaining audit doesn't retain the PII.

A deletion that updates Postgres but leaves the index, caches, or dependent rows is
incomplete — the same "every trace is gone" bar the architecture applies to code,
applied to data.

---

## The Two-Layer Model Shapes Deletion

Because of the canonical-vs-tenant split (see `data-model.md`), "delete" means
different things at different layers:

- **Deleting a tenant's Contact/Prospect** removes *that workspace's working record
  and relationship* — their notes, ownership, list memberships, deal links. It does
  **not** necessarily remove the canonical Person, which other workspaces may
  reference.
- **A subject-deletion request against the canonical Person** (a person exercising
  their right to be removed from the dataset entirely) removes/anonymises the
  canonical record and propagates so no tenant retains their PII. This is the
  heavier operation and the one compliance is most concerned with.

Knowing which deletion is being asked for is the first step — they have different
scopes and different propagation.

---

## Anonymisation vs Hard Deletion

Not everything can be hard-deleted (referential integrity, legitimate aggregate
records), so the per-entity choice is deliberate (see `data-model.md`):

- **Hard delete** — the row is gone. Used where nothing legitimate needs it to
  persist.
- **Soft delete** — the row is tombstoned with a `deletedAt` timestamp and excluded
  from normal reads, pending a hard-delete/anonymise sweep or a recovery window.
  The soft-delete tombstone is how the user-facing "delete" is implemented for
  recoverable working records; it is **not** the end state for PII (the sweep must
  still complete the real deletion below).
- **Anonymise** — the row stays for integrity/aggregate reasons but its personal
  fields are irreversibly stripped/replaced (e.g. an activity record keeps "a
  prospect was contacted on this date" but no longer identifies who). Used where a
  hard delete would break references or destroy non-personal value.
- The choice is made so that **after deletion, the person is not identifiable** —
  anonymisation that can be trivially reversed isn't deletion.

---

## Subject Deletion and DSAR

Individuals have rights over their data (see `truepoint-security` compliance):

- **Right to deletion**: the system can find *all* of a person's data — canonical
  and across tenant references — and remove/anonymise it. This only works if the
  model lets a person's data be *found*, which is why identity resolution and
  references-not-copies (see `data-model.md`, `enrichment-pipeline.md`) matter:
  scattered, unlinked copies can't be reliably deleted.
- **Right of access (DSAR)**: a person/workspace can obtain the data held about
  them. The export feature (architecture dependency-wiring) doubles as this
  mechanism — and is therefore itself **tenant-scoped, access-controlled, and
  rate-limited** (an unscoped export is a bulk leak — see security data-protection).
- The **`dsar_requests`** table is **platform-owned** — it has no tenant FK and is
  deliberately *not* tenant-scoped, because a subject-deletion/access request spans
  every tenant that references the person. It is therefore accessed **only via the
  privileged `leadwolf_admin` role** (the audited cross-tenant role), never the
  ordinary `leadwolf_app` role.
- **Consent withdrawal auto-suppresses**: a consent record with a `withdrawnAt`
  timestamp automatically suppresses the affected data from contactable/processable
  use — withdrawal is honoured by suppression, not left to a manual cleanup.
- These run as **jobs** (they can be large — platform async-jobs), are **audited**
  (a deletion/access request is itself a recorded event), and are **idempotent**.

---

## Retention Policies and Automated Sweeps

Data ages out automatically, not by manual cleanup:

- **Retention periods are defined per data class** (activity logs, call records,
  stale prospects, soft-deleted records) and enforced by **scheduled sweep jobs**
  (platform async-jobs, leader-locked scheduler).
- Sweeps are **batched and idempotent** so they don't lock tables or exhaust
  connections on huge tables (platform data-platform), and they respect
  partitioning — dropping an aged time-partition is cheaper than row-by-row
  deletion (platform data-platform).
- Siloed/enterprise tenants may have **contractual retention terms** that differ —
  the policy is configurable per tenant where required (residency/contract — see
  security compliance).

---

## Audit Survives, Without the PII

The one thing that deliberately outlives deletion is the audit trail — but it was
designed to hold IDs and actions, never the personal contents (see security
data-protection, data-model AuditEvent). So "user X deleted prospect 123 on this
date" persists for accountability; "the email was jane@…" never was stored there to
begin with. Retaining audit therefore doesn't undermine deletion.

---

## Checklist

- Does deletion handle the record, dependent tenant data, the index, caches, and
  (within their window) backups — leaving no orphaned PII?
- Is it clear whether a tenant working-record delete or a canonical subject deletion
  is being performed, with the right scope and propagation?
- Is hard-delete-vs-anonymise chosen per entity so the person is not identifiable
  afterward?
- Can a person's data be *found* across canonical + tenant references for subject
  deletion (references-not-copies, identity resolution)?
- Is the DSAR/export path tenant-scoped, access-controlled, rate-limited, and
  audited?
- Are retention sweeps scheduled, batched, idempotent, partition-aware, and
  per-tenant-configurable where required?
- Does audit persist with IDs/actions only, never the personal contents?
