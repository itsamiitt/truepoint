// masterConfidencePolicy.ts — the tunable inputs to the confidence/freshness model (Group E).
// Migration 0107. Outcomes: [S-09] minimize likelihood the person has left · [S-10] confidence visible at a
// glance · [S-13] fast job-change detection.
//
// THE MODEL THIS TABLE PARAMETERIZES (03-target-architecture.md §4):
//   confidence(field) = base(source_weight) × corroboration(source_count) × decay(age, half_life)
// All three inputs already exist in the graph — source_name/source_type, source_count, and the
// observed_at/recorded_at split. What was missing is the CURVE, and 08-architecture is explicit that
// "Decay curves are Phase 2 — not built". Today a five-year-old assertion and a fresh one score identically,
// which directly undermines S-09, S-13 and S-10.
//
// WHY A TABLE RATHER THAN CONSTANTS IN CODE
// Research R4 found reported B2B decay clustering around ~2.1%/month (~22.5%/yr), with published ranges from
// 22.5% to 70.3% — and EVERY one of those figures comes from a data vendor selling the cure. The direction
// and the dominant driver (job change) are consistent across independent sources; the coefficient is not
// trustworthy. Hard-coding someone's marketing number as a physical constant would bake an unverifiable
// claim into the scoring path.
//
// So: ship the SHAPE with defaults, and calibrate the numbers against TruePoint's own bounce and
// reverification telemetry, which `verification_jobs` and the reverification sweeps already collect. The
// seeded values below are STARTING POINTS FOR CALIBRATION, not researched constants. Tuning is an UPDATE,
// not a deploy.
//
// R1 supplies the other half: 6sense states decay logic VARIES BY SOURCE TYPE, and that active sources are
// weighted more heavily than passive ones "reflecting the directness and verifiability of their signals".
// A DNS detection and a job-posting mention cannot share a half-life, so the key is (field, source_type).
//
// ROLLOUT DISCIPLINE (04-validation.md): decay ships DISPLAY-ONLY first — the S-10 badge — before it
// influences ranking, and only then reveal gating. A wrong half-life must never silently downgrade good
// records before it has been watched against real telemetry. `is_enabled` is the switch that keeps that
// honest.
//
// ACCESS MODEL: Layer 0 — system-owned, isolated by access path. Named master_* so the `^master_`
// convention loop in applyMigrations.ts GRANTS revokes it by default. The app never reads this table: it
// reads the COMPUTED confidence stored in field_provenance. The policy is an input to the server-side fold,
// not a client-facing value.

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().default(sql`uuid_generate_v7()`);

// The source_type vocabulary is EXACTLY provenance_event.source_type (migration 0089) plus '*'. One
// vocabulary across the provenance spine and the scoring policy — if these drift, a policy row silently
// matches nothing and the field falls back to the wildcard without anyone noticing.
const SOURCE_TYPES = sql`('provider','import','coop','forge','crawl','user_edit','reveal','extension',
  'crm_sync','mailbox','*')`;

export const masterConfidencePolicy = pgTable(
  "master_confidence_policy",
  {
    id: id(),
    // Field name as it appears in provenance_event.field ('jobTitle', 'primary_domain', …), or '*' for any.
    field: varchar("field", { length: 50 }).notNull(),
    sourceType: varchar("source_type", { length: 30 }).notNull(),
    // NULL = DOES NOT DECAY. A funding round that happened stays happened; a registry-sourced legal name
    // does not become less true with age. Only facts that can silently stop being true need a half-life.
    halfLifeDays: integer("half_life_days"),
    // Multiplier in [0,1] applied before decay. R1: active sources (DNS, direct verification) outrank
    // passive ones (a mention in a job posting) "reflecting the directness and verifiability of their
    // signals".
    sourceWeight: numeric("source_weight", { precision: 4, scale: 3 }).notNull().default("1.000"),
    // source_count at which corroboration SATURATES. The second independent source is worth far more than
    // the tenth; without a ceiling, a spammy source repeated ten times would outscore two good ones.
    corroborationCeiling: integer("corroboration_ceiling").notNull().default(5),
    // The rollout switch. Disabled rows are inert — the fold treats them as "no policy", which resolves to
    // the wildcard, which is today's behaviour. This is what makes the whole feature shippable dark.
    isEnabled: boolean("is_enabled").notNull().default(true),
    // Why this number. Free text on purpose: the calibration story matters more than the number, and a value
    // nobody can explain is a value nobody dares change.
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // RESOLUTION ORDER, most specific first — the fold must implement exactly this and nothing else:
    //   1. (field, source_type)   2. ('*', source_type)   3. (field, '*')   4. ('*', '*')
    // ('*','*') is seeded, so a lookup can never miss and the fold never needs a hard-coded fallback.
    uniqPolicy: uniqueIndex("uniq_master_confidence_policy").on(t.field, t.sourceType),
    sourceTypeEnum: check(
      "master_confidence_policy_source_type_enum",
      sql`${t.sourceType} IN ${SOURCE_TYPES}`,
    ),
    halfLifePositive: check(
      "master_confidence_policy_half_life_positive",
      sql`${t.halfLifeDays} IS NULL OR ${t.halfLifeDays} > 0`,
    ),
    weightRange: check(
      "master_confidence_policy_weight_range",
      sql`${t.sourceWeight} BETWEEN 0 AND 1`,
    ),
    ceilingPositive: check(
      "master_confidence_policy_ceiling_positive",
      sql`${t.corroborationCeiling} >= 1`,
    ),
  }),
);
