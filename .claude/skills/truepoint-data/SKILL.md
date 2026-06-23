---
name: truepoint-data
description: >
  The data model and data-product skill for TruePoint — the canonical schema, how
  records are owned and shared, and the data subsystems that make TruePoint a sales
  intelligence product: the enrichment pipeline, verification, search, and data
  retention/deletion. Use this skill whenever defining or changing an entity or its
  relationships, working out who can see which record, building or modifying
  enrichment or verification, building search/filtering over the prospect dataset,
  or handling data retention and deletion. It builds on truepoint-platform (the
  database, tenancy, queues, and search infrastructure) and is enforced by
  truepoint-security (access control, residency). If a change touches what the data
  IS, who owns it, how it gets enriched, how it is searched, or how it is deleted,
  this skill is active.
---

# TruePoint Data Skill

A sales intelligence product is, at its core, a data product. Its value is the
quality of its contact and company data, how cleanly that data is deduplicated and
enriched, how fast and precisely it can be searched, and how correctly it is owned,
shared, and eventually deleted. This skill governs all of that — the model and the
data subsystems built on it.

It builds on **truepoint-platform**, which provides the database, the tenancy
model, the queues, the caching, and the search infrastructure this skill uses. It
is enforced by **truepoint-security**, which owns access control and residency.
This skill decides *what the data is and how it flows*; platform decides *where it
runs*; security decides *who may touch it*.

---

## Which Skill, When

- **truepoint-data** (this skill) — the data model, ownership/sharing, enrichment,
  verification, search relevance, retention/deletion mechanics.
- **truepoint-platform** — the database, tenancy, partitioning, queues, the search
  engine itself, caching. This skill runs on top of it.
- **truepoint-security** — tenant isolation enforcement (RLS), who can access a
  record, data residency, what may be sent to providers.
- **truepoint-architecture / design** — how the frontend reads and renders this
  data.

Take "enrich a prospect's email":
- Data (this skill): the waterfall across providers, dedup against existing
  records, the verification step, what's cached.
- Platform: the enrichment queue, the worker, the result cache.
- Security: the provider key stays server-side, SSRF rules on outbound calls, only
  the minimum PII leaves to the provider, EU-prospect residency.

---

## The Core Principles

- **One canonical model, owned here.** Entities, their relationships, and their
  ownership semantics are defined in `references/data-model.md`. Security and the
  frontend build on that definition — a model that isn't written down is one
  every feature guesses at differently.
- **Postgres is the source of truth; the index is the query surface.** The
  large prospect/company dataset is *stored* in Postgres and *searched* via a
  `SearchPort` adapter. They are kept in sync by a pipeline; they are never two
  independent sources (see `search-infrastructure.md`).
- **Identity is resolved, not assumed.** The same person or company arrives from
  many sources in many shapes. Dedup via an explicit identity hierarchy is how the
  dataset stays clean instead of accumulating duplicates (see
  `enrichment-pipeline.md`).
- **Enrichment is metered and cached.** Provider calls cost money; the same lookup
  is never paid for twice. Caching and cost-aware ordering are part of the
  pipeline, not optimisations (see `enrichment-pipeline.md` and
  `truepoint-operations` FinOps).
- **Visibility defaults to the owner; sharing is explicit.** A record is filtered
  to its soft-owner within the workspace by default; broader visibility is granted
  explicitly (see `ownership-and-sharing.md`). The hard boundary is RLS at the
  workspace; ownership is a filter dimension layered on top.
- **Deletion is real.** When data is deleted — by retention policy or a subject
  request — it and its dependent PII actually go, not orphaned (see
  `retention-and-deletion.md`).

---

## Reference Files

| Task | Read |
|---|---|
| Defining/changing an entity, relationship, or ownership field | `references/data-model.md` |
| Deciding who can see a record; owner scope; sharing; teams | `references/ownership-and-sharing.md` |
| Building/changing enrichment; provider waterfall; dedup | `references/enrichment-pipeline.md` |
| Email/phone verification | `references/verification.md` |
| Search, faceted filtering, indexing, relevance over the dataset | `references/search-infrastructure.md` |
| Data retention, deletion, anonymisation, subject deletion | `references/retention-and-deletion.md` |

---

## Companion Skills

This skill defines the data and its flows. It depends on **truepoint-platform**
for the infrastructure that runs them, is enforced by **truepoint-security** for
access and residency, and feeds **truepoint-architecture/design** for how the data
is presented. A data feature is typically governed by data + platform + security
at once: this skill says what the data is and how it moves, platform says where it
runs and how it scales, security says who may touch it and where it may live.
