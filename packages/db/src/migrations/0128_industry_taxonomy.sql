-- 0128_industry_taxonomy.sql — the controlled industry taxonomy [S-02][A-01]
-- (hand-authored, additive-only; docs/planning/market-intelligence/06-architecture.md MI-S3).
--
-- Before this, `industry`/`sub_industry` were free-form varchars on both master_companies and accounts —
-- no lookup table, no hierarchy, zero NAICS/SIC/GICS anywhere — so every industry facet was string
-- equality against unnormalized vendor spellings (02-gap-analysis: "the weakest data-model area", and the
-- prerequisite for every market rollup). The master_technology_categories tree is the in-repo pattern.
--
-- SHAPE: a two-level tree (sector → subsector) + an alias table mapping vendor spellings onto nodes.
-- The free-text columns STAY (raw vendor truth, provenance-folded); industry_id is the CANONICAL node,
-- a derived column like master_persons.current_company_id — resolved at landing / by backfill, never
-- hand-authored by the fold. The seeded vocabulary is a STARTING POINT for curation (the 0107
-- philosophy): tuning is an INSERT/UPDATE on these rows, not a deploy.
--
-- ACL: master_-prefixed, so the ^master_ wall covers the app role entirely (layerZeroWall.test.ts —
-- no exceptions, executable). er gets SELECT (alias resolution at landing); customer-facing labels go
-- through an API seam under withErTx or a denormalized column, never an app-role join. Explicit
-- grants in applyMigrations.ts.

CREATE TABLE IF NOT EXISTS "master_industries" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "parent_id" uuid REFERENCES "master_industries"("id") ON DELETE CASCADE,
  "code" varchar(50) NOT NULL UNIQUE,
  "label" varchar(120) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_industry_aliases" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "industry_id" uuid NOT NULL REFERENCES "master_industries"("id") ON DELETE CASCADE,
  "alias" citext NOT NULL UNIQUE,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "master_companies" ADD COLUMN IF NOT EXISTS "industry_id" uuid REFERENCES "master_industries"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "industry_id" uuid REFERENCES "master_industries"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_master_companies_industry_id" ON "master_companies" ("industry_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_accounts_industry_id" ON "accounts" ("workspace_id", "industry_id");
--> statement-breakpoint
-- Seed: 15 sectors. Codes are stable slugs; labels are display copy.
INSERT INTO master_industries (code, label) VALUES
  ('technology',               'Technology'),
  ('healthcare',               'Healthcare & Life Sciences'),
  ('financial-services',       'Financial Services'),
  ('manufacturing',            'Manufacturing & Industrial'),
  ('retail-consumer',          'Retail & Consumer Goods'),
  ('energy-utilities',         'Energy & Utilities'),
  ('media-entertainment',      'Media & Entertainment'),
  ('telecommunications',       'Telecommunications'),
  ('transportation-logistics', 'Transportation & Logistics'),
  ('real-estate-construction', 'Real Estate & Construction'),
  ('education',                'Education'),
  ('government-nonprofit',     'Government & Nonprofit'),
  ('professional-services',    'Professional Services'),
  ('hospitality-travel',       'Hospitality & Travel'),
  ('agriculture',              'Agriculture & Food Production')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint
-- Selected subsectors (second level). parent resolved by code.
INSERT INTO master_industries (code, label, parent_id)
SELECT v.code, v.label, p.id
  FROM (VALUES
    ('software',           'Software',                    'technology'),
    ('it-services',        'IT Services & Consulting',    'technology'),
    ('hardware',           'Hardware & Semiconductors',   'technology'),
    ('biotech-pharma',     'Biotech & Pharmaceuticals',   'healthcare'),
    ('providers-hospitals','Providers & Hospitals',       'healthcare'),
    ('medical-devices',    'Medical Devices',             'healthcare'),
    ('banking',            'Banking',                     'financial-services'),
    ('insurance',          'Insurance',                   'financial-services'),
    ('investment-mgmt',    'Investment Management',       'financial-services')
  ) AS v(code, label, parent)
  JOIN master_industries p ON p.code = v.parent
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint
-- Every label is its own alias (case-insensitive via citext), so curated labels resolve directly.
INSERT INTO master_industry_aliases (industry_id, alias)
SELECT id, label FROM master_industries
ON CONFLICT (alias) DO NOTHING;
--> statement-breakpoint
-- Vendor-spelling aliases (LinkedIn-style strings observed in the wild). Curation appends here.
INSERT INTO master_industry_aliases (industry_id, alias)
SELECT i.id, v.alias
  FROM (VALUES
    ('software development',                                'software'),
    ('computer software',                                   'software'),
    ('internet',                                            'software'),
    ('information technology & services',                   'it-services'),
    ('it services and it consulting',                       'it-services'),
    ('computer hardware',                                   'hardware'),
    ('semiconductors',                                      'hardware'),
    ('hospitals and health care',                           'providers-hospitals'),
    ('hospital & health care',                              'providers-hospitals'),
    ('pharmaceutical manufacturing',                        'biotech-pharma'),
    ('pharmaceuticals',                                     'biotech-pharma'),
    ('biotechnology research',                              'biotech-pharma'),
    ('biotechnology',                                       'biotech-pharma'),
    ('medical equipment manufacturing',                     'medical-devices'),
    ('banking',                                             'banking'),
    ('insurance',                                           'insurance'),
    ('investment management',                               'investment-mgmt'),
    ('financial services',                                  'financial-services'),
    ('retail',                                              'retail-consumer'),
    ('consumer goods',                                      'retail-consumer'),
    ('manufacturing',                                       'manufacturing'),
    ('industrial machinery manufacturing',                  'manufacturing'),
    ('oil and gas',                                         'energy-utilities'),
    ('utilities',                                           'energy-utilities'),
    ('renewable energy',                                    'energy-utilities'),
    ('media production',                                    'media-entertainment'),
    ('entertainment providers',                             'media-entertainment'),
    ('telecommunications',                                  'telecommunications'),
    ('transportation, logistics, supply chain and storage', 'transportation-logistics'),
    ('logistics and supply chain',                          'transportation-logistics'),
    ('real estate',                                         'real-estate-construction'),
    ('construction',                                        'real-estate-construction'),
    ('higher education',                                    'education'),
    ('education management',                                'education'),
    ('e-learning',                                          'education'),
    ('government administration',                           'government-nonprofit'),
    ('non-profit organizations',                            'government-nonprofit'),
    ('management consulting',                               'professional-services'),
    ('business consulting and services',                    'professional-services'),
    ('staffing and recruiting',                             'professional-services'),
    ('accounting',                                          'professional-services'),
    ('law practice',                                        'professional-services'),
    ('hospitality',                                         'hospitality-travel'),
    ('travel arrangements',                                 'hospitality-travel'),
    ('farming',                                             'agriculture'),
    ('food production',                                     'agriculture'),
    ('food and beverage manufacturing',                     'agriculture')
  ) AS v(alias, code)
  JOIN master_industries i ON i.code = v.code
ON CONFLICT (alias) DO NOTHING;
--> statement-breakpoint
-- Backfill: map existing free-text industries onto nodes where an alias already matches. Unmatched rows
-- stay NULL (honest gap) — the landing path resolves new rows, curation grows the alias table for the rest.
UPDATE master_companies mc
   SET industry_id = a.industry_id
  FROM master_industry_aliases a
 WHERE mc.industry_id IS NULL
   AND mc.industry IS NOT NULL
   AND a.alias = mc.industry::citext;
--> statement-breakpoint
UPDATE accounts ac
   SET industry_id = a.industry_id
  FROM master_industry_aliases a
 WHERE ac.industry_id IS NULL
   AND ac.industry IS NOT NULL
   AND a.alias = ac.industry::citext;
