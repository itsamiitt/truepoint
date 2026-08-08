CREATE TABLE "master_confidence_policy" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"field" varchar(50) NOT NULL,
	"source_type" varchar(30) NOT NULL,
	"half_life_days" integer,
	"source_weight" numeric(4, 3) DEFAULT '1.000' NOT NULL,
	"corroboration_ceiling" integer DEFAULT 5 NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "master_confidence_policy_source_type_enum" CHECK ("master_confidence_policy"."source_type" IN ('provider','import','coop','forge','crawl','user_edit','reveal','extension',
  'crm_sync','mailbox','*')),
	CONSTRAINT "master_confidence_policy_half_life_positive" CHECK ("master_confidence_policy"."half_life_days" IS NULL OR "master_confidence_policy"."half_life_days" > 0),
	CONSTRAINT "master_confidence_policy_weight_range" CHECK ("master_confidence_policy"."source_weight" BETWEEN 0 AND 1),
	CONSTRAINT "master_confidence_policy_ceiling_positive" CHECK ("master_confidence_policy"."corroboration_ceiling" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_master_confidence_policy" ON "master_confidence_policy" USING btree ("field","source_type");--> statement-breakpoint

-- ── HAND-APPENDED SEED (everything above this line is drizzle-kit generated) ────────────────────────────
-- The starting policy. THESE NUMBERS ARE CALIBRATION STARTING POINTS, NOT RESEARCHED CONSTANTS — read the
-- header of schema/masterConfidencePolicy.ts before changing them, and read this before quoting them.
--
-- Reported B2B contact decay clusters around ~2.1%/month (~22.5%/yr), with published ranges running from
-- 22.5% to 70.3%. Every one of those figures comes from a data vendor selling the cure. The DIRECTION and
-- the dominant driver (job change) are consistent across independent sources; the COEFFICIENT is not
-- trustworthy. So the shape ships with defaults and the numbers get calibrated against TruePoint's own
-- bounce and reverification telemetry, which verification_jobs and the reverification sweeps already
-- collect. Tuning is an UPDATE, not a deploy.
--
-- Resolution order the fold MUST implement, most specific first:
--   1. (field, source_type)   2. ('*', source_type)   3. (field, '*')   4. ('*', '*')
-- ('*','*') is seeded, so a lookup can never miss and the fold needs no hard-coded fallback.
--
-- half_life_days NULL = does not decay. Applied to facts that cannot silently stop being true.
-- ON CONFLICT DO NOTHING per the migrator's seed convention: the tolerance set deliberately does NOT
-- swallow 23505, so every seed guards itself.
INSERT INTO master_confidence_policy (field, source_type, half_life_days, source_weight, corroboration_ceiling, notes) VALUES
  -- The universal fallback. Deliberately gentle: an unknown (field, source) pair should not be aggressively
  -- discounted just because nobody has written a policy for it yet.
  ('*',                '*',        730,  0.700, 5, 'Universal fallback. ~2y half-life; deliberately gentle for unclassified pairs.'),

  -- Per-source-type weights. R1 (6sense, verbatim): active sources are weighted more heavily than passive
  -- ones "reflecting the directness and verifiability of their signals".
  ('*',                'reveal',   365,  0.950, 3, 'ACTIVE: a paid reveal was verified at purchase time.'),
  ('*',                'user_edit',730,  0.950, 2, 'ACTIVE: a human in the tenant asserted it deliberately.'),
  ('*',                'provider', 545,  0.850, 5, 'Licensed provider. Good, but not independently verified by us.'),
  ('*',                'coop',     365,  0.750, 4, 'Contributor network. Corroboration matters more here than elsewhere.'),
  ('*',                'forge',    365,  0.750, 4, 'Forge contribution pipeline; already review-gated upstream.'),
  ('*',                'import',   545,  0.600, 5, 'Customer CSV. Unknown provenance and frequently stale on arrival.'),
  ('*',                'crm_sync', 545,  0.700, 5, 'Customer CRM. As accurate as their hygiene, which varies.'),
  ('*',                'extension',270,  0.800, 4, 'User-initiated page capture: a human was looking at it.'),
  ('*',                'crawl',    180,  0.550, 6, 'PASSIVE inference. Weakest signal, so it needs the most corroboration.'),
  ('*',                'mailbox',  270,  0.900, 3, 'ACTIVE: derived from real delivery/engagement events.'),

  -- Per-FIELD half-lives. This is where the "decay varies by what the fact IS" part lives.
  -- Employment-derived facts decay fastest because job change is the dominant driver of all contact decay.
  ('jobTitle',         '*',        365,  0.800, 4, 'Job change is the dominant decay driver. Reported title change ~66%/yr.'),
  ('department',       '*',        365,  0.800, 4, 'Moves with the role.'),
  ('seniorityLevel',   '*',        545,  0.800, 4, 'Changes more slowly than title.'),
  ('currentCompanyId', '*',        365,  0.850, 4, 'The S-09 field: has this person left the company.'),

  -- Contact channels. Work email is tied to employment, so it dies with the job — often within days.
  ('email',            '*',        300,  0.850, 4, 'Work email dies with the job; reported ~37%/yr change.'),
  ('phone',            '*',        450,  0.800, 4, 'Direct dials outlive email but not the role; reported ~43%/yr.'),

  -- Company-level facts are far more stable than person-level ones, and some do not decay at all.
  ('primaryDomain',    '*',        NULL, 0.900, 3, 'A domain does not silently stop being the domain.'),
  ('name',             '*',        NULL, 0.900, 3, 'Rebrands are events we observe, not decay.'),
  ('industry',         '*',        1095, 0.750, 5, 'Slow-moving classification.'),
  ('employeeBand',     '*',        365,  0.700, 5, 'Headcount bands move with growth; worth re-checking yearly.'),
  ('revenueRange',     '*',        545,  0.650, 5, 'Rarely disclosed, frequently estimated.'),

  -- Technology adoption. R1: recency dominates, and the half-life differs sharply by detection method —
  -- a DNS record is a live fact, a job-posting mention is an inference about a past intent.
  ('technology',       'crawl',    120,  0.700, 4, 'Web/DNS fingerprint: live but shallow, and front-end biased.'),
  ('technology',       'provider', 240,  0.800, 4, 'Purchased technographics; refresh cadence is the vendor''s.'),
  ('technology',       'forge',    240,  0.700, 4, 'Job-posting derived: catches back-office systems, lags reality.')
ON CONFLICT (field, source_type) DO NOTHING;