# Phase 3 — Target Architecture

**Inputs:** `01-research.md` (RD-1…RD-9), `02-audit.md` (D1…D9), `03a-contribution-architecture.md`
(CD-1…CD-5). **Nothing below is implemented yet** — this is the design that Phase 4 validates and Phase 5
migrates.

**Conventions this design obeys** (from the shipped code, not from the cascade documents):

| The cascade documents say | TruePoint does | This design uses |
|---|---|---|
| Prefixed ULID text PKs (`tech_…`) | `uuid("id").primaryKey().default(sql\`uuid_generate_v7()\`)` | **uuid v7** |
| `pgEnum` / free text | `varchar(n)` + a `check()` constraint, or a lookup table | **varchar + CHECK**, except where D6 says lookup |
| Citus shard keys | single Postgres 16, RLS on Layer 1, access-path isolation on Layer 0 | **no shard keys** |
| ClickHouse for the big edge | RD-5: Postgres-only, monthly range partitioning | **partitioned Postgres** |
| `source_id` FK to a `sources` table | `source_name varchar(50)` + `source_records` + `provenance_event` | **existing provenance spine** |
| Bitemporal `valid_from`/`valid_to`/`recorded_at` | `observed_at` (valid) + `recorded_at` (transaction), SCD2 via `started_on`/`ended_on` | **existing 1.5-temporal idiom** |

Adopting cascade's ULID/Citus/ClickHouse conventions would fork the schema's identity idiom for one subtree.
The *shapes* in those documents are good; the *substrate* is a different product's.

---

## 1. What is being added, and why — the seven questions, per change group

The brief requires each significant change to answer seven questions. Rather than repeat them per table,
they are answered per **change group**; the DDL follows in §2.

### Group A — Technology intelligence (new)

1. **Research found** the market converges on catalog + dated adoption edge, with confidence built from
   recency × corroboration × source weight, and decay logic that **varies by source type** (R1, 6sense
   verbatim). PredictLeads and TheirStack ship exactly this split.
2. **Current system:** one untyped jsonb column, `master_companies.technographics` (`masterGraph.ts:69`).
3. **What is wrong:** cannot answer "which companies use X" — the primary technographic query. No per-value
   provenance, no first/last seen, no detection method, no confidence. It is a fact in the graph with no
   provenance event behind the individual value, which is in tension with 08-architecture invariant 1.
4. **Proposed:** first-class `master_technologies` catalog + `technology_categories` tree +
   `technology_aliases` + bitemporal `technology_vendors` + a partitioned
   `company_technology_adoptions` edge.
5. **Why better:** makes the primary query an index scan; puts every detection under the existing
   provenance spine; makes displacement signals (tech X out, tech Y in) fall out of the data rather than
   needing new machinery; and the vendor link turns a flat lookup into competitive intelligence.
6. **Risks/trade-offs:** the adoption edge is the largest table in the design. Mitigated by monthly range
   partitioning (R7: the ceiling is partition count, ~12/year vs. "a few thousand"), and by the fact that
   TruePoint has no crawl fleet and is not building one (non-goal S-05) — coverage arrives via licensed
   feeds, so growth is bounded by what is bought.
7. **Data protection:** the jsonb column is **kept and dual-written**, never dropped in the same release.
   Backfill reads it; a later release retires it once parity is proven. No existing data is destroyed.

### Group B — Product intelligence (new, and reinterpreted)

1. **Research found no established B2B product-intelligence entity model** (R2). Everything returned is
   commerce catalog (Salesforce: Catalog → Category → Product → Media → variants), which models products
   *you sell in a store* — a different problem.
2. **Current system:** nothing.
3. **What is wrong:** nothing is wrong; it is absent. The risk is inventing a parallel hierarchy on no
   evidence.
4. **Proposed (RD-3 / conflict C7):** a product **is** a technology seen from the vendor's end. A row in
   `master_technologies` with a `technology_vendors` row of `relationship='creator'` is that vendor's
   product. Add `technology_features` for the feature list the brief's Product Profile wants, and a
   `kind` discriminator so a non-adoptable product (a service, a physical good) is representable.
5. **Why better:** one catalog, one ER path, one alias table, one provenance surface. The
   product↔technology mapping problem the brief lists disappears because they are the same row. It also
   makes the Product Profile and Technology Profile two views of one entity, which is what the brief's own
   field lists imply — both ask for category, vendor, adoption, sources, confidence, history.
6. **Risks/trade-offs:** if products later need attributes technologies never have (SKUs, pricing tiers,
   regional availability), the discriminator column grows sparse and this decision must be revisited. The
   escape hatch is cheap: `kind` already partitions the table logically, so splitting later is a copy, not
   a redesign.
7. **Data protection:** purely additive; nothing exists to protect.

### Group C — Market/company signals (new)

1. **Research found** six industry-consistent signal families (R3); only family 5 (intent/content
   engagement) is deferred non-goal X-04.
2. **Current system:** `intent_signals` — tenant + workspace + contact scoped, with a **closed 9-value CHECK
   enum** (`intel.ts:78-84`).
3. **What is wrong:** three separate problems. (a) A canonical market fact ("Acme raised a Series B") is not
   tenant data and has nowhere to live. (b) Every new signal type is a migration. (c) The table is
   contact-scoped, so a company-level signal cannot be attached at all.
4. **Proposed:** `master_signals` at Layer 0 — subject-polymorphic (company or person), with
   `signal_types` as a **lookup table** rather than a CHECK enum (fixes D6), monthly range-partitioned by
   `observed_at`.
5. **Why better:** signals become corroborable across tenants, carry provenance like every other fact, and
   feed both the scoring path and the profile UI. `intent_signals` stays exactly as it is — it remains the
   correct home for *tenant-private* engagement, and is now fed by, rather than confused with, the
   canonical store.
6. **Risks/trade-offs:** subject-polymorphism (a `subject_type`/`subject_id` pair) cannot carry an FK.
   This is deliberate and already precedented — `provenance_event.entity_id` has no FK for the same reason
   and documents why. The cost is referential integrity enforced in the repository, not the database.
7. **Data protection:** `intent_signals` is untouched. Additive only.

### Group D — Person & company completeness (extends existing tables)

Fixes audit D7 (company locations only at Layer 1), D8 (one identifier column per source), D9
(`master_employment.master_company_id` is NOT NULL, so an unresolved employer cannot be recorded at all).

The D9 change is the only modification to an existing column in this entire design: dropping a `NOT NULL`
and adding `company_name_raw`. Dropping a NOT NULL constraint cannot destroy a row — every existing row
already satisfies the weaker constraint. This is the cascade documents' single best structural idea
(`cascade 1.md` §2.3): keep the raw name **and** the resolved id, so an assertion survives until ER
catches up instead of being rejected at the door.

**Deferred deliberately:** `person_skills`, `person_educations`, `person_languages`. Conflict C6 stands —
they serve no listed outcome, and CLAUDE.md rule 1 says work serving no outcome gets flagged, not built.
Note that cascade 1's genuinely valuable idea here — *one vocabulary shared by person skills and company
technologies* — is **preserved without building the skills tables**: `master_technologies` is that
vocabulary, and `technology_skill_map` is a two-column table that can be added the day a skills outcome
exists.

### Group E — Confidence decay (new, pure code)

1. **Research found** decay ~2.1%/month compounding to ~22.5%/yr, job change dominant, but every published
   coefficient comes from a vendor selling the cure (R4). 6sense states decay logic **varies by source
   type** (R1).
2. **Current system:** `last_verified_at` and the `observed_at`/`recorded_at` split exist; 08-architecture
   states "Decay curves are Phase 2 — not built." Confidence never ages.
3. **What is wrong:** a five-year-old assertion and a fresh one score identically. That directly undermines
   S-09, S-13, and S-10.
4. **Proposed:** a pure fold in `packages/core/src/prospect/` beside `fieldProvenance.ts`, with half-life a
   **configurable per-(field, source_type) parameter**, defaulted and then calibrated against TruePoint's
   own bounce/reverification telemetry.
5. **Why better:** it uses evidence the platform already collects instead of a number from a blog, and the
   inert-config pattern means it ships defaulting to today's behaviour.
6. **Risks/trade-offs:** a wrong half-life silently degrades good records. Mitigated by shipping the decay
   **display-only first** (S-10 badge) before it influences ranking or reveal.
7. **Data protection:** pure function over existing columns. Writes nothing until wired.

---

## 2. DDL — target schema

> **Naming superseded in Phase 5.** Every new Layer-0 table takes the `master_` prefix
> (`technology_categories` → `master_technology_categories`, `company_technology_adoptions` →
> `master_technology_adoptions`, `signal_types` → `master_signal_types`, …). Reason: `applyMigrations.ts`
> already carries a convention-based catch-all that revokes `leadwolf_app` from every table matching
> `^master_`, and the names below would not have matched — each would have been auto-GRANTed at CREATE time.
> See `05-migration-plan.md` §Naming decision. The DDL below is otherwise as implemented.

New Drizzle schema files under `packages/db/src/schema/`. All Layer 0: **no `tenant_id`, no
`workspace_id`, no owner column** — isolation by access path, matching `masterGraph.ts:6-9`.

### 2.1 `masterTechnology.ts`

```ts
// Layer 0, system-owned. Catalog cardinality is low (tens of thousands); the ADOPTION EDGE is the
// large table and lives in masterAdoption.ts, partitioned.

export const technologyCategories = pgTable("technology_categories", {
  id: id(),
  name: varchar("name", { length: 120 }).notNull(),
  slug: citext("slug").notNull(),
  parentId: uuid("parent_id").references((): AnyPgColumn => technologyCategories.id),
  createdAt: createdAt(),
}, (t) => ({
  uniqSlug: uniqueIndex("uniq_technology_categories_slug").on(t.slug),
  parentIdx: index("idx_technology_categories_parent").on(t.parentId),
}));

export const masterTechnologies = pgTable("master_technologies", {
  id: id(),
  canonicalName: varchar("canonical_name", { length: 200 }).notNull(),
  slug: citext("slug").notNull(),                       // the natural key (UNIQUE)
  kind: varchar("kind", { length: 20 }).notNull().default("technology"),
    // technology | product | service — the RD-3 discriminator (see Group B)
  description: text("description"),
  categoryId: uuid("category_id").references(() => technologyCategories.id),
  vendorDomain: citext("vendor_domain"),                // pre-ER hint; the authority is technology_vendors
  isOpenSource: boolean("is_open_source"),
  isSaas: boolean("is_saas"),
  pricingModel: varchar("pricing_model", { length: 20 }).array().notNull().default(sql`'{}'`),
  cpe23: varchar("cpe23", { length: 255 }),             // OPTIONAL external key (R10) — never the PK
  wikidataQid: varchar("wikidata_qid", { length: 32 }), // OPTIONAL external key
  // Stack relationships, modeled as arrays of technology ids (enthec implies/requires/excludes).
  impliesTechIds: uuid("implies_tech_ids").array().notNull().default(sql`'{}'`),
  requiresTechIds: uuid("requires_tech_ids").array().notNull().default(sql`'{}'`),
  excludesTechIds: uuid("excludes_tech_ids").array().notNull().default(sql`'{}'`),
  blockKey: varchar("block_key", { length: 255 }),      // ER blocking, reserved like master_persons
  fieldProvenance: jsonb("field_provenance").notNull().default({}),
  provHwm: timestamp("prov_hwm", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  uniqSlug: uniqueIndex("uniq_master_technologies_slug").on(t.slug),
  uniqCpe: uniqueIndex("uniq_master_technologies_cpe").on(t.cpe23).where(sql`${t.cpe23} IS NOT NULL`),
  kindEnum: check("master_technologies_kind_enum",
    sql`${t.kind} IN ('technology','product','service')`),
  categoryIdx: index("idx_master_technologies_category").on(t.categoryId),
}));

export const technologyAliases = pgTable("technology_aliases", {
  id: id(),
  technologyId: uuid("technology_id").notNull()
    .references(() => masterTechnologies.id, { onDelete: "cascade" }),
  alias: citext("alias").notNull(),
  aliasType: varchar("alias_type", { length: 20 }),     // rename | abbreviation | misspelling | locale
  sourceName: varchar("source_name", { length: 50 }),
  createdAt: createdAt(),
}, (t) => ({
  uniqAlias: uniqueIndex("uniq_technology_aliases_alias").on(t.alias, t.technologyId),
  aliasLookupIdx: index("idx_technology_aliases_lookup").on(t.alias),  // the ER resolution path
}));

// Vendor link — SCD2 so an acquisition NEVER rewrites "who created it" (cascade 2 §3; correct, adopted).
export const technologyVendors = pgTable("technology_vendors", {
  id: id(),
  technologyId: uuid("technology_id").notNull()
    .references(() => masterTechnologies.id, { onDelete: "cascade" }),
  masterCompanyId: uuid("master_company_id").notNull()
    .references(() => masterCompanies.id, { onDelete: "cascade" }),
  relationship: varchar("relationship", { length: 20 }).notNull(), // creator | current_owner | former_owner
  startedOn: date("started_on").notNull().default(sql`'-infinity'`), // same unknown-start sentinel idiom
  endedOn: date("ended_on"),
  sourceName: varchar("source_name", { length: 50 }),
  confidence: numeric("confidence", { precision: 4, scale: 3 }),
  observedAt: timestamp("observed_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => ({
  relEnum: check("technology_vendors_relationship_enum",
    sql`${t.relationship} IN ('creator','current_owner','former_owner')`),
  endedAfterStarted: check("technology_vendors_ended_after_started",
    sql`${t.endedOn} IS NULL OR ${t.endedOn} >= ${t.startedOn}`),
  uniqLink: uniqueIndex("uniq_technology_vendors_link")
    .on(t.technologyId, t.masterCompanyId, t.relationship, t.startedOn),
  // At most ONE open current_owner per technology — DB-enforced, mirroring uniq_employment_primary.
  uniqCurrentOwner: uniqueIndex("uniq_technology_current_owner")
    .on(t.technologyId).where(sql`${t.relationship} = 'current_owner' AND ${t.endedOn} IS NULL`),
  companyIdx: index("idx_technology_vendors_company").on(t.masterCompanyId),
}));

// The Product Profile's feature list (Group B). Rows only where kind='product'.
export const technologyFeatures = pgTable("technology_features", {
  id: id(),
  technologyId: uuid("technology_id").notNull()
    .references(() => masterTechnologies.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 200 }).notNull(),
  description: text("description"),
  sourceName: varchar("source_name", { length: 50 }),
  observedAt: timestamp("observed_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => ({
  uniqFeature: uniqueIndex("uniq_technology_features").on(t.technologyId, t.name),
}));
```

**Deferred:** `technology_versions`. Cascade 2's own recommendation, and nothing in TruePoint's outcome
table needs version-level displacement. The seam is `cpe23`, which already encodes version when present.

### 2.2 `masterAdoption.ts` — the one large table

```ts
// PARTITIONED BY RANGE (observed_at), monthly. Drizzle cannot express partitioning, so this file follows
// the provenanceEvent.ts precedent: HAND-AUTHORED migration, and the module is NOT re-exported from
// schema/index.ts so drizzle-kit never emits DDL for it.

export const companyTechnologyAdoptions = pgTable("company_technology_adoptions", {
  id: uuid("id").notNull().default(sql`uuid_generate_v7()`),
  masterCompanyId: uuid("master_company_id").notNull(),
  technologyId: uuid("technology_id").notNull(),
  detectionMethod: varchar("detection_method", { length: 30 }).notNull(),
    // web_fingerprint | job_posting | dns | self_declared | integration | filing | manual
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  removedAt: timestamp("removed_at", { withTimezone: true }), // set when a detection stops — displacement
  confidence: numeric("confidence", { precision: 4, scale: 3 }),
  sourceCount: integer("source_count").notNull().default(1),
  sourceName: varchar("source_name", { length: 50 }),
  evidenceRef: uuid("evidence_ref"),        // source_records.id — the "show me why" link (no FK: retention)
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),  // PARTITION KEY
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.id, t.observedAt] }),   // partition key must be in the PK
  // "Which companies use X" — THE query the jsonb blob cannot answer.
  techIdx: index("idx_adoption_technology").on(t.technologyId, t.lastSeenAt.desc()),
  // "What does this company run" — the company profile read.
  companyIdx: index("idx_adoption_company").on(t.masterCompanyId, t.technologyId),
  // Displacement scan: recently-removed detections.
  removedIdx: index("idx_adoption_removed").on(t.removedAt).where(sql`${t.removedAt} IS NOT NULL`),
  methodEnum: check("adoption_detection_method_enum",
    sql`${t.detectionMethod} IN ('web_fingerprint','job_posting','dns','self_declared',
                                  'integration','filing','manual')`),
  confidenceRange: check("adoption_confidence_range",
    sql`${t.confidence} IS NULL OR ${t.confidence} BETWEEN 0 AND 1`),
}));
```

**Why this is the whole C2 decision made concrete.** Cascade 2 puts this table in ClickHouse on an
explicitly-labelled estimate ("tens of billions … if you match BuiltWith-scale coverage"). TruePoint will
not match BuiltWith-scale coverage — that is non-goal S-05, and there is no crawl fleet. Monthly
partitioning costs 12 partitions/year against a documented planner comfort zone of "a few thousand" (R7),
and dropping a partition is dramatically cheaper than a bulk DELETE. **Revisit trigger, written down:**
rows > 1.5B **or** p95 latency on `idx_adoption_technology` above SLO for two consecutive weeks.

**A dedup note that matters:** `uniq` on (company, technology, method) is deliberately *absent*. The grain
is one row per detection episode; a re-detection after removal is a **new** episode, which is exactly what
makes the displacement timeline reconstructable. Collapsing to one row per pair would destroy the signal
the whole table exists to produce. Idempotency comes from upstream (`source_records.content_hash`), as it
already does everywhere else in this pipeline.

### 2.3 `masterSignals.ts`

```ts
// Signal TYPE is a lookup table, not a CHECK enum — audit D6: a closed enum makes every new signal
// family a migration, and the brief asks for a vocabulary that grows.

export const signalTypes = pgTable("signal_types", {
  code: varchar("code", { length: 50 }).primaryKey(),   // funding_round | leadership_change | …
  family: varchar("family", { length: 30 }).notNull(),  // hiring|funding|tech_change|leadership|filing|other
  label: varchar("label", { length: 120 }).notNull(),
  defaultWeight: integer("default_weight").notNull().default(1),
  halfLifeDays: integer("half_life_days"),              // per-type decay (R1: decay varies by source type)
  isEnabled: boolean("is_enabled").notNull().default(true),
}, (t) => ({
  familyEnum: check("signal_types_family_enum",
    sql`${t.family} IN ('hiring','funding','tech_change','leadership','filing','other')`),
  // Deliberately NO 'intent' family — that is deferred non-goal X-04 (research R3, conflict C5).
}));

export const masterSignals = pgTable("master_signals", {
  id: uuid("id").notNull().default(sql`uuid_generate_v7()`),
  subjectType: varchar("subject_type", { length: 10 }).notNull(),  // company | person
  subjectId: uuid("subject_id").notNull(),   // no FK — polymorphic, same rationale as provenance_event
  typeCode: varchar("type_code", { length: 50 }).notNull(),
  headline: varchar("headline", { length: 500 }),
  payload: jsonb("payload").notNull().default({}),   // typed per signal family; NEVER PII
  amountMinor: bigint("amount_minor", { mode: "number" }),  // funding rounds etc.; currency below
  currency: char("currency", { length: 3 }),
  relatedCompanyId: uuid("related_company_id"),      // acquirer, investor, new employer
  relatedTechnologyId: uuid("related_technology_id"),// for tech_change signals
  confidence: numeric("confidence", { precision: 4, scale: 3 }),
  sourceName: varchar("source_name", { length: 50 }),
  evidenceRef: uuid("evidence_ref"),
  evidenceUrl: text("evidence_url"),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),  // PARTITION KEY
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.id, t.observedAt] }),
  subjectIdx: index("idx_master_signals_subject").on(t.subjectType, t.subjectId, t.observedAt.desc()),
  typeIdx: index("idx_master_signals_type").on(t.typeCode, t.observedAt.desc()),
  subjectTypeEnum: check("master_signals_subject_type_enum",
    sql`${t.subjectType} IN ('company','person')`),
}));
```

`payload` carries **no PII**, for the same reason `provenance_event.payload` does not: a signal store must
not become a second cleartext personal-data store. A `leadership_change` signal references
`master_persons.id`; it does not embed the person's contact details.

### 2.4 `masterCompanyDetail.ts` — audit D7 + funding + contact points

```ts
export const masterCompanyLocations = pgTable("master_company_locations", {
  id: id(),
  masterCompanyId: uuid("master_company_id").notNull()
    .references(() => masterCompanies.id, { onDelete: "cascade" }),
  kind: varchar("kind", { length: 20 }).notNull(),   // hq | office | plant | registered
  addressLine: varchar("address_line", { length: 255 }),
  city: varchar("city", { length: 120 }),
  region: varchar("region", { length: 120 }),
  countryCode: char("country_code", { length: 2 }),
  postalCode: varchar("postal_code", { length: 20 }),
  sourceCount: integer("source_count").notNull().default(1),
  confidence: numeric("confidence", { precision: 4, scale: 3 }),
  observedAt: timestamp("observed_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => ({
  companyIdx: index("idx_company_locations_company").on(t.masterCompanyId),
  uniqHq: uniqueIndex("uniq_company_hq").on(t.masterCompanyId).where(sql`${t.kind} = 'hq'`),
  kindEnum: check("company_locations_kind_enum",
    sql`${t.kind} IN ('hq','office','plant','registered')`),
}));

// Company switchboard / generic mailbox. NOT personal data — but treated with the same channel
// discipline anyway, because "info@" mailboxes are frequently routed to one identifiable person.
export const masterCompanyContactPoints = pgTable("master_company_contact_points", {
  id: id(),
  masterCompanyId: uuid("master_company_id").notNull()
    .references(() => masterCompanies.id, { onDelete: "cascade" }),
  kind: varchar("kind", { length: 20 }).notNull(),   // switchboard | generic_email | fax
  valueNormalized: citext("value_normalized").notNull(),
  verificationStatus: varchar("verification_status", { length: 20 }).notNull().default("unverified"),
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
  sourceCount: integer("source_count").notNull().default(1),
  confidence: numeric("confidence", { precision: 4, scale: 3 }),
  createdAt: createdAt(),
}, (t) => ({
  uniqPoint: uniqueIndex("uniq_company_contact_point")
    .on(t.masterCompanyId, t.kind, t.valueNormalized),
  kindEnum: check("company_contact_points_kind_enum",
    sql`${t.kind} IN ('switchboard','generic_email','fax')`),
}));

export const masterCompanyFunding = pgTable("master_company_funding", {
  id: id(),
  masterCompanyId: uuid("master_company_id").notNull()
    .references(() => masterCompanies.id, { onDelete: "cascade" }),
  roundType: varchar("round_type", { length: 30 }),   // seed | series_a | … | debt | ipo | grant
  amountMinor: bigint("amount_minor", { mode: "number" }),
  currency: char("currency", { length: 3 }),
  announcedOn: date("announced_on"),
  leadInvestorCompanyId: uuid("lead_investor_company_id").references(() => masterCompanies.id),
  sourceName: varchar("source_name", { length: 50 }),
  confidence: numeric("confidence", { precision: 4, scale: 3 }),
  evidenceUrl: text("evidence_url"),
  createdAt: createdAt(),
}, (t) => ({
  companyIdx: index("idx_company_funding_company").on(t.masterCompanyId, t.announcedOn.desc()),
  uniqRound: uniqueIndex("uniq_company_funding_round")
    .on(t.masterCompanyId, t.roundType, t.announcedOn),
}));
```

Every funding row is also a `master_signals` row of `family='funding'` — the table is the **structured
fact**, the signal is the **dated event**. Keeping both is deliberate: the profile reads the fact, the feed
reads the event, and neither has to reshape the other's data.

### 2.5 `masterPersonIdentifiers.ts` — audit D8

```ts
export const masterPersonIdentifiers = pgTable("master_person_identifiers", {
  id: id(),
  masterPersonId: uuid("master_person_id").notNull()
    .references(() => masterPersons.id, { onDelete: "cascade" }),
  idType: varchar("id_type", { length: 40 }).notNull(),
    // linkedin_public_id | linkedin_urn | github_login | x_handle | provider:<name> | …
  idValue: citext("id_value").notNull(),
  sourceName: varchar("source_name", { length: 50 }),
  observedAt: timestamp("observed_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => ({
  // Global uniqueness per (type, value) — this is what makes it an ER join key, matching
  // the posture of master_emails.email_blind_index.
  uniqIdentifier: uniqueIndex("uniq_person_identifier").on(t.idType, t.idValue),
  personIdx: index("idx_person_identifier_person").on(t.masterPersonId),
}));
```

`master_persons.linkedin_public_id` **stays**. It is a hot, indexed, single-column lookup used across the
codebase; this table generalizes *additional* identifiers rather than replacing the primary one. Removing it
would be a wide, risky refactor for no outcome. A backfill copies it in as `id_type='linkedin_public_id'`
so both agree.

### 2.6 Change to `master_employment` — audit D9

```sql
ALTER TABLE master_employment ALTER COLUMN master_company_id DROP NOT NULL;
ALTER TABLE master_employment ADD COLUMN company_name_raw varchar(255);
```

Plus a CHECK so a row is never entirely companyless:
`CHECK (master_company_id IS NOT NULL OR company_name_raw IS NOT NULL)`.

**Consequence to handle in Phase 5:** `uniq_employment_stint` is
`(master_person_id, master_company_id, started_on)`. In Postgres, a UNIQUE index treats NULLs as distinct,
so unresolved stints will not collide. That is *correct* for now (two unresolved employers may be genuinely
different companies) but it means unresolved rows do not dedup. Mitigation: a second partial unique on
`(master_person_id, lower(company_name_raw), started_on) WHERE master_company_id IS NULL`, which dedups by
raw name until ER resolves it. **This is exactly the kind of detail Phase 4 exists to catch.**

---

## 3. Identity resolution ladder — exact → strong → probabilistic → review

The brief's four tiers, mapped to what exists and what is added. Research R5 is decisive: **blocking is the
constraint, not scoring.**

| Tier | People | Companies | Technologies | State |
|---|---|---|---|---|
| **Exact** | `email_blind_index` (HMAC, globally unique), `phone_blind_index`, `master_person_identifiers` | `primary_domain` (PSL eTLD+1), `linkedin_company_id` | `slug`, `cpe23` | ✅ shipped (+ identifiers new) |
| **Strong** | identifier from a trusted source + name agreement | `alt_domains[]` match, exact `name_normalized` + country | `technology_aliases` exact | ◐ partly |
| **Probabilistic** | blocked candidate scoring (Fellegi–Sunter) | same | alias fuzzy | ✖ reserved (`block_key` unindexed) |
| **Review** | `match_links.review_status` + `forge.review_tasks` | same | same | ✅ shipped |

**Probabilistic tier design (new).** Offline, queued, bounded — never on the request path:
1. **Block** with a deterministic key that yields small groups. For persons: `lower(last_name) ||
   left(lower(first_name),1) || country`. For companies: normalized-name trigram bucket + country.
   No similarity function *inside* the blocking rule (Splink's explicit warning — it forces evaluation
   across all pairs before filtering).
2. **Cap** block size. A block over N members is skipped and flagged, not expanded — this is what keeps the
   quadratic away.
3. **Score** with m/u weights per attribute. The arithmetic is trivial; it needs no Splink runtime, no
   Spark, no new service. It runs in `apps/workers/src/queues/erSweep.ts` over
   `forge.match_candidates`.
4. **Route** by threshold: auto-merge above, `review_status='pending'` in the band, discard below. The
   review UI already exists at `apps/forge/src/features/review`.
5. **Index `block_key`** — the one schema change this tier needs. It is currently reserved specifically so
   this could switch on without a destructive migration (`masterGraph.ts:75-77`), which is exactly the
   affordance being used.

---

## 4. Confidence & freshness model

```
confidence(field) = base(source_weight) × corroboration(source_count) × decay(age, half_life)
```

- `source_weight` — per `source_name`, active sources outrank passive (R1, 6sense verbatim). Config table,
  not code constants.
- `corroboration` — a saturating function of `source_count`; the second independent source is worth far
  more than the tenth. This is the Noisy-OR shape cascade 1 describes, and TruePoint already stores the
  input.
- `decay` — `exp(-ln2 × age_days / half_life_days)`, half-life resolved per **(field, source_type)**, with
  defaults seeded from R4 (~9–12 months for email, ~24 months for identity fields) and **calibrated against
  TruePoint's own bounce and reverification telemetry**, not shipped as vendor numbers.

Placement: `packages/core/src/prospect/confidence.ts`, a pure function beside `fieldProvenance.ts`. Config
in a `confidence_policy` table so half-lives are tunable without a deploy.

**Rollout discipline:** display-only first (the S-10 badge), then ranking, then reveal gating. A wrong
half-life must never silently downgrade good records before it has been observed against real telemetry.

---

## 5. Read model & the four profiles (feeds Phase 8)

| Profile | Reads |
|---|---|
| **Company** | `master_companies` + locations + funding + contact points + `company_technology_adoptions` (current) + `master_signals` (subject=company) + `master_employment` (leadership) + `field_provenance` badge |
| **Prospect** | `master_persons` + `master_employment` (career timeline, SCD2 = the timeline for free) + identifiers + channels (reveal-gated) + `master_signals` (subject=person) + company context |
| **Technology** | `master_technologies` + category + aliases + vendors (bitemporal) + adoption edge aggregates (adopters, recent adds, recent removals) + implies/requires/excludes graph |
| **Product** | the same row with `kind='product'`, read from the vendor side + `technology_features` |

The design thesis from research R9 — **neither ZoomInfo nor Apollo surfaces "last verified" in their
standard UI** — means provenance and freshness are primary elements on all four, not a detail drawer.

**One performance note for Phase 4:** "current technologies for this company" over a partitioned,
episode-grained edge is a per-company scan across partitions. If profile latency suffers, the answer is a
narrow `company_technology_current` projection maintained by the existing `projection_outbox` +
`projectionSweep` machinery — **not** a new datastore. Measure first.

---

## 6. Migration plan sketch (detail lands in `05-migration-plan.md`)

Every step additive; nothing dropped in the same release as its replacement.

| # | Migration | Risk |
|---|---|---|
| 0100 | `technology_categories`, `master_technologies`, `technology_aliases`, `technology_vendors`, `technology_features` | None — new tables |
| 0101 | `company_technology_adoptions` + monthly partitions (**hand-authored**, provenanceEvent precedent) | None — new |
| 0102 | `signal_types`, `master_signals` + partitions (**hand-authored**) | None — new |
| 0103 | company locations / contact points / funding; `master_person_identifiers` | None — new |
| 0104 | `master_employment`: drop NOT NULL, add `company_name_raw` + CHECK + partial unique | **Low** — weakening a constraint cannot invalidate an existing row |
| 0105 | index `block_key` on both master tables (CONCURRENTLY) | Low — index build on a large table; do it concurrently |
| 0106 | `confidence_policy` config table | None |
| 0107 | backfill `technographics` jsonb → adoption edge; **read-only against the source** | Low — jsonb column retained |
| 0108+ | RLS/GRANT files for every new Layer-0 table, mirroring `rls/masterGraph.sql` | **Must not be forgotten** — a new Layer-0 table with a default grant is a tenancy hole |

**0108 is the one that must not slip.** Every table above is Layer 0 and must be `REVOKE`d from
`leadwolf_app` exactly as `masterGraph.ts` describes. A new system-owned table that inherits a blanket grant
is a cross-tenant exposure, not a style issue — and per the memory note on RLS denial manifestations, the
isolation itest must assert *"changed nothing"*, not *"threw"*, since UPDATE/DELETE under a missing policy
silently affects zero rows.

---

## 7. Outcome IDs (CLAUDE.md rule 1)

| Change group | Outcomes |
|---|---|
| A — technology intelligence | S-04 (targeting precision), S-13 (change detection), A-01 (provenance per value) |
| B — product intelligence | S-04, A-01 |
| C — signals | S-13 (job change / leadership change), S-09 (has the person left), A-01 |
| D — person/company completeness | S-09, S-04, A-01 |
| E — confidence decay | S-09, S-10, S-13 |
| ER probabilistic tier | A-03 (keep fabricated/duplicate records out), S-10 |

Nothing in this design serves an unlisted outcome. Skills, education, and languages were **cut for exactly
that reason** (conflict C6).

---

## 8. Open items for Phase 4 validation

1. The `uniq_employment_stint` NULL-distinctness consequence (§2.6) — proposed partial unique needs proving.
2. Adoption-edge episode grain vs. any upstream that assumes one-row-per-pair.
3. Whether `company_technology_current` projection is needed at launch or deferred behind measurement.
4. Partition creation automation — `partitionSweep.ts` and `partitionRepository.ts` already exist; confirm
   they generalize to two new partitioned tables rather than being provenance-specific.
5. Compliance checklist pass on `master_signals` (a `leadership_change` signal names a person) and on
   `master_company_contact_points` (generic mailboxes can be personal data in practice).
6. The R8 notification-on-first-storage question, still unresolved.
7. CD-1 verification: does `apps/api` `/ingest` already delegate to `landEnvelope`?
