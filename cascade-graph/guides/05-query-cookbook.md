# 05 — Query Cookbook

Every relationship in your brief, written as runnable SQL against the schema in files `02`–`04`. Each query names the traversal it performs so you can see the typed edges being followed. All use the example rows (Alex, Siya, Sage, Google, SPPU, DPU, and the technologies).

Convention: `valid_to IS NULL` on every join filters to *currently-true* facts; drop it (and add `as_of`) for historical queries (§8).

---

## 1. Person → Organization (works-at)

### "Where does Alex work?"
```sql
SELECT o.display_name, p.title, p.started_on
FROM person_positions p
JOIN organizations o ON o.org_id = p.org_id
WHERE p.person_id = 'pn_01ALEX…'
  AND p.relationship_type = 'employee'
  AND p.is_current AND p.valid_to IS NULL;
-- → Sage | Software Engineer | 2021-03-01
```

### "Who else works at Sage?" (reverse traversal — the Siya answer)
```sql
SELECT pr.full_name, p.title
FROM person_positions p
JOIN persons pr ON pr.person_id = p.person_id
WHERE p.org_id = 'org_01SAGE…'
  AND p.relationship_type = 'employee'
  AND p.is_current AND p.valid_to IS NULL;
-- → Alex Mehta | Software Engineer
--   Siya Rao   | Product Manager
```

### "Who are Alex's colleagues?" (two hops: Alex → org → other people)
```sql
SELECT DISTINCT c.full_name, cp.title
FROM person_positions me
JOIN person_positions cp ON cp.org_id = me.org_id
JOIN persons c ON c.person_id = cp.person_id
WHERE me.person_id = 'pn_01ALEX…' AND me.is_current
  AND cp.person_id <> me.person_id AND cp.is_current
  AND me.valid_to IS NULL AND cp.valid_to IS NULL;
-- → Siya Rao | Product Manager
```

---

## 2. Person → Organization (studied-at)

### "Where did Alex study?"
```sql
SELECT o.display_name, e.degree, e.ended_year
FROM person_educations e
JOIN organizations o ON o.org_id = e.org_id
WHERE e.person_id = 'pn_01ALEX…' AND e.valid_to IS NULL;
-- → Savitribai Phule Pune University | B.Tech | 2019
```

### "Who are the alumni of SPPU?"
```sql
SELECT pr.full_name, e.degree
FROM person_educations e
JOIN persons pr ON pr.person_id = e.person_id
WHERE e.org_id = 'org_01SPPU…' AND e.valid_to IS NULL;
-- → Alex Mehta | B.Tech
```

### "Every institution Alex is connected to" (work + study, one read)
```sql
SELECT * FROM person_org_affiliations WHERE person_id = 'pn_01ALEX…';
-- → org_01SAGE… | employment | employee | Software Engineer | 2021-03-01 | true
--   org_01SPPU… | education  | student  | B.Tech            | 2015       | NULL
```

---

## 3. Organization → Technology (the develops-vs-uses split)

### ⭐ "What did Sage BUILD?"
```sql
SELECT t.canonical_name
FROM org_technology_relations r
JOIN technologies t ON t.technology_id = r.technology_id
WHERE r.org_id = 'org_01SAGE…'
  AND r.relationship_type = 'develops'
  AND r.valid_to IS NULL;
-- → Sage Intacct
--   Sage 50
--   Sage X3
```

### ⭐ "What does Sage RUN?" (same node, different edge type)
```sql
SELECT t.canonical_name, r.first_seen_at, r.detection_method
FROM org_technology_relations r
JOIN technologies t ON t.technology_id = r.technology_id
WHERE r.org_id = 'org_01SAGE…'
  AND r.relationship_type = 'uses'
  AND r.valid_to IS NULL;
-- → WordPress               | 2023-02-10 | webappanalyzer
--   Google Analytics        | 2022-11-01 | webappanalyzer
--   Google Keyword Planner  | 2023-05-19 | job_posting
```

These two queries differ by **one line** (`relationship_type`) and return completely disjoint sets. That is the entire point of the design.

### "What did Google build?"
```sql
SELECT t.canonical_name
FROM org_technology_relations r
JOIN technologies t ON t.technology_id = r.technology_id
WHERE r.org_id = 'org_01GOOGLE…' AND r.relationship_type = 'develops' AND r.valid_to IS NULL;
-- → Google Analytics
--   Google Keyword Planner
```

---

## 4. Technology → Organization (who made / uses it)

### "Who develops WordPress?" (reverse traversal on develops)
```sql
SELECT o.display_name
FROM org_technology_relations r
JOIN organizations o ON o.org_id = r.org_id
WHERE r.technology_id = 'tech_01WORDPRESS…' AND r.relationship_type = 'develops' AND r.valid_to IS NULL;
```

### "Who USES Google Analytics?" (the adopter list — for outreach)
```sql
SELECT o.display_name, r.first_seen_at
FROM org_technology_relations r
JOIN organizations o ON o.org_id = r.org_id
WHERE r.technology_id = 'tech_01GA…' AND r.relationship_type = 'uses' AND r.valid_to IS NULL;
-- → Sage | 2022-11-01   (…and every other adopter)
```

### "Who CREATED Google Analytics, and who owns it now?" (bitemporal ledger)
```sql
SELECT o.display_name, v.relationship, v.valid_from, v.valid_to
FROM technology_vendors v
JOIN organizations o ON o.org_id = v.org_id
WHERE v.technology_id = 'tech_01GA…'
ORDER BY v.valid_from;
-- → Google | creator       | 2005-04-14 | NULL
--   Google | current_owner | 2005-04-14 | NULL
```

### "Who recently DROPPED WordPress?" (the displacement signal — closed rows, no special type)
```sql
SELECT o.display_name, r.valid_to AS dropped_at, r.last_seen_at, r.detection_method
FROM org_technology_relations r
JOIN organizations o ON o.org_id = r.org_id
WHERE r.technology_id = 'tech_01WORDPRESS…'
  AND r.relationship_type = 'uses'
  AND r.valid_to >= now() - interval '90 days';       -- closed within the window
-- Optionally join a fresh 'uses' row in the same category to name the replacement —
-- the same install-plus-category-movement construction HG Insights uses for displacement context.
```
This is why `deprecated_use` doesn't exist as a type: the closed `uses` row already *is* the fact, and this query is the signal.

---

## 5. The composed traversals (the real value)

### ⭐ "What does Sage run, and who made each of those tools?" (uses → creator)
```sql
SELECT tool.canonical_name AS sage_runs, maker.display_name AS built_by
FROM org_technology_relations u
JOIN technologies tool       ON tool.technology_id = u.technology_id
JOIN technology_vendors v    ON v.technology_id = u.technology_id AND v.relationship = 'creator' AND v.valid_to IS NULL
JOIN organizations maker     ON maker.org_id = v.org_id
WHERE u.org_id = 'org_01SAGE…' AND u.relationship_type = 'uses' AND u.valid_to IS NULL;
-- → WordPress              | Automattic
--   Google Analytics       | Google
--   Google Keyword Planner | Google
```
This is your exact example — "Sage uses Google Analytics, Google developed Google Analytics" — resolved as one query across two typed edges.

### "Find marketing people at companies that USE a Google-built product" (develops → uses → employee)
```sql
SELECT pr.full_name, comp.display_name AS company, tool.canonical_name AS shared_tool
FROM org_technology_relations dev                                   -- Google develops X
JOIN technologies tool     ON tool.technology_id = dev.technology_id
JOIN org_technology_relations use ON use.technology_id = dev.technology_id  -- company uses X
                              AND use.relationship_type = 'uses' AND use.valid_to IS NULL
JOIN organizations comp    ON comp.org_id = use.org_id
JOIN person_positions pos  ON pos.org_id = comp.org_id AND pos.is_current AND pos.valid_to IS NULL
JOIN persons pr            ON pr.person_id = pos.person_id
WHERE dev.org_id = 'org_01GOOGLE…' AND dev.relationship_type = 'develops' AND dev.valid_to IS NULL
  AND pos.job_function = 'marketing';
-- Four typed hops: Google —develops→ tool ←uses— company ←employee— person(marketing)
```

### "Alumni of SPPU who now work at a company that builds ERP" (student → employee → develops)
```sql
SELECT pr.full_name, comp.display_name, erp.canonical_name
FROM person_educations edu
JOIN persons pr           ON pr.person_id = edu.person_id
JOIN person_positions pos ON pos.person_id = pr.person_id AND pos.is_current AND pos.valid_to IS NULL
JOIN organizations comp   ON comp.org_id = pos.org_id
JOIN org_technology_relations dev ON dev.org_id = comp.org_id
                              AND dev.relationship_type = 'develops' AND dev.valid_to IS NULL
JOIN technologies erp     ON erp.technology_id = dev.technology_id
JOIN technology_categories cat ON cat.category_id = erp.category_id AND cat.path <@ 'software.enterprise.erp'
WHERE edu.org_id = 'org_01SPPU…' AND edu.relationship_type = 'student' AND edu.valid_to IS NULL;
```

> **Depth budget.** Every composed query above is 2–4 typed hops, which is squarely inside what Postgres executes well as plain joins. That boundary is real: recursive/deep traversals degrade sharply — practitioner measurements put recursive CTEs at seconds by ~5 hops on multi-million-row edge tables and timeouts near 10 ([four-approaches comparison](https://evokoa.com/blog/postgres-as-a-graph-database/); [Postgres's recursive executor "is an iterative set processor, not a traversal framework"](https://dev.to/ineron/your-postgresql-already-has-a-graph-engine-you-just-have-to-build-it-2ng7)). Anything deeper or fan-out-heavy ("everyone within 3 hops of any Google product") belongs on the projection, not OLTP — file `06` §7.

---

## 6. Evidence / provenance queries

### "How do we know Alex works at Sage?" (the attestation trail)
```sql
SELECT a.source_class, a.raw_assertion, a.seen_at
FROM person_positions p
JOIN relationship_attestations a ON a.edge_table = 'person_positions' AND a.edge_id = p.position_id
WHERE p.person_id = 'pn_01ALEX…' AND p.org_id = 'org_01SAGE…'
ORDER BY a.seen_at DESC;
-- → licensed_provider | "Alex Mehta — Software Engineer, Sage"    | 2026-07-28
--   web_public        | "Alex Mehta | Sage | Engineering"        | 2026-03-11
```

---

## 7. Confidence-composed reads

### "Sage's product portfolio, only high-confidence edges"
```sql
SELECT t.canonical_name, r.confidence
FROM org_technology_relations r
JOIN technologies t ON t.technology_id = r.technology_id
WHERE r.org_id = 'org_01SAGE…' AND r.relationship_type = 'develops'
  AND r.confidence >= 0.8 AND r.valid_to IS NULL
ORDER BY r.confidence DESC;
```

---

## 8. Time-travel (bitemporal as-of)

### "What did Sage's stack look like on 2024-01-01?"
```sql
SELECT t.canonical_name
FROM org_technology_relations r
JOIN technologies t ON t.technology_id = r.technology_id
WHERE r.org_id = 'org_01SAGE…' AND r.relationship_type = 'uses'
  AND r.valid_from <= '2024-01-01'
  AND (r.valid_to IS NULL OR r.valid_to > '2024-01-01');
```

### "Who owned Sage Intacct on 2016-01-01?" (before the Sage acquisition)
```sql
SELECT o.display_name
FROM technology_vendors v
JOIN organizations o ON o.org_id = v.org_id
WHERE v.technology_id = 'tech_01INTACCT…' AND v.relationship = 'current_owner'
  AND v.valid_from <= '2016-01-01'
  AND (v.valid_to IS NULL OR v.valid_to > '2016-01-01');
-- → Intacct Inc.   (not Sage — the acquisition was 2017)
```

> The queries above travel the **valid-time** axis (what was true in the world on date X). The other axis — *what did we believe on date X* — is answered from the append-only attestation log (`WHERE seen_at <= X`), since edge rows hold current belief (04 §1). Keeping the axes separate is what makes a correction distinguishable from a real-world change (Fowler).

---

## 9. The cheat-sheet — every question maps to one typed traversal

| Question | Edge(s) followed |
|---|---|
| Where does Alex work? | `person_positions[employee]` |
| Who else works there? | `person_positions[employee]` (reverse) |
| Where did Alex study? | `person_educations[student]` |
| Alumni of SPPU? | `person_educations[student]` (reverse) |
| What did Sage build? | `org_technology_relations[develops]` |
| What does Sage run? | `org_technology_relations[uses]` |
| Who made what Sage runs? | `[uses]` → `technology_vendors[creator]` |
| What did Google build? | `org_technology_relations[develops]` |
| Marketing people at Google-tool users? | `[develops]`→`[uses]`→`person_positions[employee]` |
| SPPU alumni at ERP builders? | `[student]`→`[employee]`→`[develops]` |
