-- 0090_forge_contributor.sql — the contributor identity store behind docs/strategy/08-architecture.md
-- invariant 2 ("contributor anonymity by construction": records never expose who contributed; contributor
-- identity lives only in the provenance store, access-restricted). EXPAND ONLY and UNPOPULATED in Phase 1 —
-- the spine is completed now so the shape is settled, but no contribution flow ships until Phase 3 lands the
-- consent UX and counsel review (09-compliance §5, and the Phase 3 gate in 06-roadmap).
--
-- HAND-AUTHORED (drizzle-kit generate is forbidden for the forge schema); leadwolf_forge is granted via the
-- post-migration ALL-TABLES grant in applyMigrations, so this file adds no grants of its own.
--
-- WHY forge AND NOT A NEW `provenance` SCHEMA (human decision, 2026-07-31 — see decisions.md D5)
-- The alternative was a third least-privilege schema+role owning contributor alone. Reusing the shipped forge
-- firewall means no new role to operate, and forge.raw_captures.captured_by_user_id is already the closest
-- thing to contributor identity in the system. What the guarantee still buys, and what it gives up:
--
--   HOLDS — the product-level C-02 promise. leadwolf_app (the customer role) has NO grant anywhere in the
--   forge schema, so no request served to a user can resolve a contributor, by any query. Equally important,
--   leadwolf_er — the role that WRITES provenance_event — has no forge grant either, so the very path that
--   records contributor_ref cannot turn it back into a person. contributor_ref stays a bare uuid in `public`
--   with no FK and no resolvable referent (0089).
--
--   GIVES UP — blast-radius isolation. leadwolf_forge holds DML on ALL TABLES IN SCHEMA forge, plus ALTER
--   DEFAULT PRIVILEGES, so every forge worker can read contributor identity whether or not it needs to. A
--   compromised or simply buggy forge job therefore reaches further than it would have under a dedicated
--   role. This is an accepted trade, not an oversight; if it is ever revisited, moving the two tables to their
--   own schema is a rename plus a grant change, because nothing in `public` references them.
--
-- The isolation itest is the guarantee; this comment is only the reasoning.

CREATE TABLE IF NOT EXISTS forge.contributor (
  -- THIS id is what provenance_event.contributor_ref holds. Opaque by construction: no FK points here from
  -- `public`, and nothing outside this schema can name the table to resolve it.
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The real identity, and the only place it exists in a contribution context. No FK to public.users: the
  -- forge schema deliberately holds no reference into the overlay (the raw_captures.target_tenant_id
  -- precedent), so a tenant purge does not reach in here and cascade-delete audit-relevant rows.
  user_id              uuid NOT NULL,
  tenant_id            uuid NOT NULL,
  channel              text NOT NULL,
  status               text NOT NULL DEFAULT 'active',
  -- Phase 3 fraud defence (A-03). Present now so the column does not have to be added under load later;
  -- nothing computes it in Phase 1 and the default is deliberately neutral, not flattering.
  reputation           numeric(4,3) NOT NULL DEFAULT 0.500,
  first_contributed_at timestamptz,
  last_contributed_at  timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT forge_contributor_channel_enum CHECK (channel IN
    ('extension','crm_sync','mailbox','manual','confirmation')),
  CONSTRAINT forge_contributor_status_enum CHECK (status IN ('active','paused','revoked','banned')),
  CONSTRAINT forge_contributor_reputation_range CHECK (reputation BETWEEN 0 AND 1)
);
--> statement-breakpoint
-- One ref per (person, channel) — deliberately NOT one global ref per user. Two channels from the same human
-- therefore produce two unlinkable refs in provenance_event, so even correlation across channels requires
-- reaching this table rather than just reading the event log.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_forge_contributor_user_channel
  ON forge.contributor (user_id, channel);
--> statement-breakpoint

-- The C-05 sharing log: what a contributor agreed to share, under which policy version, and when they
-- withdrew. 09-compliance rule 5 requires consent that is explicit, granular (per channel; per CRM
-- object/field; exclusion lists), LOGGED, and REVOCABLE — revocation stops future flow and is recorded, which
-- is why revoked_at is a nullable column on a retained row rather than a delete.
CREATE TABLE IF NOT EXISTS forge.contributor_consent (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contributor_id uuid NOT NULL REFERENCES forge.contributor (id) ON DELETE CASCADE,
  scope          jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Which published policy text the consent was given against. Without this a consent record cannot answer
  -- "what did they actually agree to", which is the only question that matters in a dispute.
  policy_version text NOT NULL,
  granted_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz
);
--> statement-breakpoint
-- The live-consent lookup the ingest path will make per contribution: one contributor, currently granted.
CREATE INDEX IF NOT EXISTS idx_forge_contributor_consent_live
  ON forge.contributor_consent (contributor_id)
  WHERE revoked_at IS NULL;

-- DOWN (manual — safe at any point in Phase 1, since the tables are unpopulated and unreferenced):
--   DROP TABLE IF EXISTS forge.contributor_consent;
--   DROP TABLE IF EXISTS forge.contributor;
