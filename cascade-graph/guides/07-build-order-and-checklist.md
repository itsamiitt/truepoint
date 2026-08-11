# 07 — Build Order, Migration Path & Acceptance Tests

The exact sequence for an agent to build this, starting from the existing CASCADE schema. Additive and reversible — no destructive change to current tables until the new ones are proven. Ends with acceptance tests that must pass (written against your example).

---

## 1. Build order (do these in sequence)

### Step 1 — Generalize `companies` → `organizations` (+ the resolution substrate)
1. `CREATE TABLE organizations (…)` per [`02`](../schema/02-organizations-and-people.md) §1.
2. Backfill: `INSERT INTO organizations SELECT …, 'company', … FROM companies`.
3. Create the `companies` compatibility **view** (02 §1) so existing queries keep working.
4. Add `idx_org_kind`, `idx_org_domain`.
5. `CREATE TABLE organization_aliases (…)`, `organization_identifiers (…)` per 02 §1b; seed identifiers from existing company domains (`id_type='domain'`) and aliases from known trade names. (Also `technology_aliases` per 03 §1b when Step 5 lands.)
**Reversible:** drop view + tables; `companies` base is untouched during backfill (copy, not move) until Step 8 cutover.

### Step 2 — Add schools as organizations
1. Resolve distinct `person_educations.school_name` values → insert `organizations` rows with `org_kind='school'` (dedupe by name/domain).
2. Keep a mapping `(school_name → org_id)` for Step 4.

### Step 3 — Extend `person_positions`
1. `ALTER TABLE person_positions ADD COLUMN relationship_type TEXT NOT NULL DEFAULT 'employee'`.
2. Rename `company_id` → `org_id` (or add `org_id`, backfill from `company_id`, keep both one release).
3. Rebuild `idx_pos_org` on `(org_id, relationship_type, is_current)`.

### Step 4 — Upgrade `person_educations`
1. `ALTER TABLE person_educations ADD COLUMN org_id TEXT REFERENCES organizations(org_id)`, `ADD COLUMN relationship_type TEXT NOT NULL DEFAULT 'student'`.
2. Backfill `org_id` from the Step 2 mapping. Keep `school_name` as raw-seen.
3. Add `idx_edu_org`.

### Step 5 — Build `org_technology_relations` (the core)
1. `CREATE TABLE org_technology_relations (…)` per [`03`](../schema/03-technology-relationships.md) §2 — including the **partial unique** `uniq_otr_open (… ) WHERE valid_to IS NULL` (a plain UNIQUE forbids re-adoption) and `detected_on_domain`.
2. **Backfill `uses` rows** from the existing `company_technologies`:
   `INSERT … SELECT company_id AS org_id, technology_id, 'uses', first_seen_at, last_seen_at, detection_method, … FROM company_technologies`.
3. **Backfill `develops` rows** from `technology_vendors` where `relationship IN ('creator','current_owner')`:
   `INSERT … SELECT org_id, technology_id, 'develops', … FROM technology_vendors WHERE relationship='current_owner' AND valid_to IS NULL`.
4. Replace `company_technologies` with the compatibility **view** (03 §2).
5. Add `idx_otr_org_type`, `idx_otr_tech_type`.
**This is where "develops vs uses" becomes real.** After this step the example queries in file `05` §3 return correct disjoint sets.

### Step 6 — Add provenance/attestation generalization
1. `CREATE TABLE relationship_attestations (…)` per [`04`](../schema/04-shared-provenance.md) §2.
2. Backfill from existing `contact_attestations` pattern where applicable (optional; new edges attest going forward).
3. Ensure `sources` table exists (04 §3).

### Step 7 — Wire ingestion
1. Add the **relationship-type classifier** (file [`06`](06-ingestion-and-resolution.md) §5) to the extraction consumer.
2. Point the org resolver at `organizations` (companies + schools), two-tier: identifiers deterministic, aliases → Splink candidates (06 §4).
3. Add the consistency rule: `develops` write refreshes `technology_vendors.current_owner`.
4. Add the **staleness sweep**: close `uses` rows whose `last_seen_at` exceeds the detection window (`valid_to = last_seen_at`) — this is what makes the displacement query (05 §4) fire.
5. Turn on CDC projections `current_employment`, `org_technology_current` — idempotent consumers, keyed by entity id (06 §7).

### Step 8 — Cutover & cleanup (only after acceptance tests pass)
1. Migrate app reads from `companies`/`company_technologies` base tables to `organizations`/`org_technology_relations` (views bridge in the meantime).
2. After a soak period, drop the old base tables (keep the views).

---

## 2. Migration dependency graph

```
Step1 (organizations) ──┬─▶ Step2 (schools) ──▶ Step4 (educations FK)
                        ├─▶ Step3 (positions.relationship_type)
                        └─▶ Step5 (org_technology_relations) ──▶ Step7 (ingestion)
Step6 (attestations) ───────────────────────────────────────────▶ Step7
All ▶ Step8 (cutover)
```

---

## 3. Acceptance tests (must all pass before cutover)

Seed the example rows, then assert. Written as plain checks an agent can run.

### T1 — develops vs uses are disjoint
```sql
-- what Sage develops must NOT include WordPress; what Sage uses must NOT include Sage Intacct
ASSERT (SELECT COUNT(*) FROM org_technology_relations
        WHERE org_id='org_01SAGE…' AND relationship_type='develops'
          AND technology_id='tech_01WORDPRESS…') = 0;
ASSERT (SELECT COUNT(*) FROM org_technology_relations
        WHERE org_id='org_01SAGE…' AND relationship_type='uses'
          AND technology_id='tech_01INTACCT…') = 0;
```

### T2 — Sage's portfolio is exactly the three products
```sql
ASSERT (SELECT array_agg(t.canonical_name ORDER BY t.canonical_name)
        FROM org_technology_relations r JOIN technologies t USING (technology_id)
        WHERE r.org_id='org_01SAGE…' AND r.relationship_type='develops' AND r.valid_to IS NULL)
     = ARRAY['Sage 50','Sage Intacct','Sage X3'];
```

### T3 — Sage's stack is exactly the three tools
```sql
ASSERT (SELECT array_agg(t.canonical_name ORDER BY t.canonical_name)
        FROM org_technology_relations r JOIN technologies t USING (technology_id)
        WHERE r.org_id='org_01SAGE…' AND r.relationship_type='uses' AND r.valid_to IS NULL)
     = ARRAY['Google Analytics','Google Keyword Planner','WordPress'];
```

### T4 — colleagues resolve (Alex ↔ Siya via Sage)
```sql
ASSERT 'Siya Rao' IN (
  SELECT c.full_name FROM person_positions me
  JOIN person_positions cp ON cp.org_id=me.org_id AND cp.person_id<>me.person_id
  JOIN persons c ON c.person_id=cp.person_id
  WHERE me.person_id='pn_01ALEX…' AND me.is_current AND cp.is_current);
```

### T5 — education resolves to a school org, not free text
```sql
ASSERT (SELECT o.org_kind FROM person_educations e
        JOIN organizations o ON o.org_id=e.org_id
        WHERE e.person_id='pn_01ALEX…') = 'school';
```

### T6 — "who made what Sage runs" composes (uses → creator)
```sql
ASSERT 'Google' IN (
  SELECT maker.display_name
  FROM org_technology_relations u
  JOIN technology_vendors v ON v.technology_id=u.technology_id AND v.relationship='creator' AND v.valid_to IS NULL
  JOIN organizations maker ON maker.org_id=v.org_id
  WHERE u.org_id='org_01SAGE…' AND u.relationship_type='uses');
```

### T7 — acquisition history is preserved (Intacct Inc. ≠ Sage as creator)
```sql
ASSERT (SELECT o.display_name FROM technology_vendors v JOIN organizations o ON o.org_id=v.org_id
        WHERE v.technology_id='tech_01INTACCT…' AND v.relationship='creator') = 'Intacct Inc.';
ASSERT (SELECT o.display_name FROM technology_vendors v JOIN organizations o ON o.org_id=v.org_id
        WHERE v.technology_id='tech_01INTACCT…' AND v.relationship='current_owner' AND v.valid_to IS NULL) = 'Sage';
```

### T8 — backward-compat views still answer old queries
```sql
ASSERT (SELECT COUNT(*) FROM companies WHERE name='Sage Group plc') = 1;                 -- view over organizations
ASSERT (SELECT COUNT(*) FROM company_technologies WHERE company_id='org_01SAGE…') = 3;    -- view = uses slice
```

### T9 — provenance present on every edge
```sql
ASSERT (SELECT COUNT(*) FROM org_technology_relations WHERE confidence IS NULL OR source_id IS NULL) = 0;
```

### T10 — re-adoption works (the partial unique earns its keep)
```sql
-- close Sage's WordPress usage, then re-open it: both must succeed, history preserved
UPDATE org_technology_relations SET valid_to = '2026-01-01'
 WHERE org_id='org_01SAGE…' AND technology_id='tech_01WORDPRESS…' AND relationship_type='uses' AND valid_to IS NULL;
INSERT INTO org_technology_relations (rel_id, org_id, technology_id, relationship_type, valid_from, source_id, confidence)
 VALUES ('rel_01READOPT…','org_01SAGE…','tech_01WORDPRESS…','uses','2026-06-01','src_01…',0.88);   -- must NOT violate uniq_otr_open
ASSERT (SELECT COUNT(*) FROM org_technology_relations
        WHERE org_id='org_01SAGE…' AND technology_id='tech_01WORDPRESS…' AND relationship_type='uses') = 2;  -- one closed + one open

-- and the displacement query (05 §4) sees the closed row:
ASSERT 'Sage Group plc' IN (
  SELECT o.legal_name FROM org_technology_relations r JOIN organizations o ON o.org_id = r.org_id
  WHERE r.technology_id='tech_01WORDPRESS…' AND r.relationship_type='uses' AND r.valid_to IS NOT NULL);
```

### T11 — resolution substrate answers the alias lookups
```sql
ASSERT (SELECT org_id FROM organization_aliases WHERE lower(alias)='sppu') = 'org_01SPPU…';
ASSERT (SELECT org_id FROM organization_identifiers WHERE id_type='domain' AND id_value='sage.com') = 'org_01SAGE…';
```

---

## 4. What "done" looks like

- All eleven acceptance tests pass on seeded example data.
- `develops` and `uses` queries return disjoint, correct sets for Sage.
- Schools and companies live in one `organizations` table; "works at" and "studied at" traverse it with different types.
- Every edge carries `source_id`, `confidence`, and bitemporal validity; attestations (each with per-sighting confidence) back at least the seeded edges.
- A closed `uses` row coexists with a re-opened one (T10), and the displacement query returns it.
- Old `companies` / `company_technologies` queries still run (via views).
- The ingestion classifier routes new org→tech facts to `develops`/`uses` and flags the uncertain ones; the staleness sweep closes stale usage.

---

## 5. Minimal build (if the agent wants the smallest correct slice first)

Ship just enough to get the develops-vs-uses win, defer the rest:

1. `organizations` (+ `companies` view) — Step 1.
2. `org_technology_relations` (+ `company_technologies` view) — Step 5.
3. Seed the example; pass T1, T2, T3.

That alone fixes the core problem in your brief. Layer schools (Steps 2/4), attestations (Step 6), and the classifier (Step 7) after.

---

## 6. File map recap

- Concepts → [`00-overview.md`](../00-overview.md), [`01-entity-model.md`](../01-entity-model.md)
- DDL → [`02`](../schema/02-organizations-and-people.md), [`03`](../schema/03-technology-relationships.md), [`04`](../schema/04-shared-provenance.md)
- Queries → [`05`](05-query-cookbook.md)
- Populate → [`06`](06-ingestion-and-resolution.md)
- Build → this file
- Serve → [`api/08`](../api/08-api-conventions.md) (conventions), [`api/09`](../api/09-api-endpoints.md) (endpoint catalog; its §11 phases interleave with the steps above)
