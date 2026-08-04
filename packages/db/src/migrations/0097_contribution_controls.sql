-- 0097_contribution_controls.sql — the customer's controls over what of THEIR data reaches the shared graph
-- (06-roadmap Phase 4 "CRM contributor controls: per-object opt-in, account/domain exclusion lists, never-share
-- fields"; 09-compliance rule 5 "explicit, granular, logged, revocable"). EXPAND ONLY: three empty tables plus
-- RLS. Nothing reads them until contributionPolicyRepository lands in the same series.
--
-- WHAT IS ACTUALLY AT STAKE, because it is subtler than "CRM sync shares data". CRM sync writes only to the
-- per-workspace overlay — it has no path to master_*. The contribution happens one hop later and unlabelled:
-- crmRunnerDeps.persist inserts a contact with master_person_id NULL, and the generic master-backfill sweep
-- resolves ANY null-bridge contact through masterGraphRepository.resolveForImport, which MINTS a golden
-- master_persons row on a clean miss. That mint is co-op-safe — identity and dedup keys only, email_enc NULL —
-- but it is still this tenant's data creating a globally visible node. A customer who says "never share
-- anything about my strategic accounts" is talking about exactly that mint, and today nothing can express it.
--
-- THREE GRAINS, THREE TABLES, on purpose:
--
--   contribution_policy      per WORKSPACE — the master switch and the never-share field set.
--   contribution_exclusion   per WORKSPACE — the domain / account / contact deny list.
--   crm_object_contribution  per (CONNECTION, OBJECT) — the per-object opt-in the roadmap names.
--
-- The exclusion list is deliberately NOT scoped to a CRM connection. "Never share anything about acme.com"
-- must hold whichever channel the record arrives through — CRM today, the extension and import tomorrow.
-- Hanging it off crm_connections would mean the same excluded account still leaks the moment a rep saves it
-- from a LinkedIn page, which is the failure the customer thinks they bought protection from.
--
-- ABSENCE IS DENIAL. Every switch defaults false and every table starts empty, so a workspace with no row
-- contributes nothing. That is the opposite of the usual expand-only convention (create it, ignore it, flip a
-- flag later) and it is the right way round here: an opt-in that defaults on is not an opt-in.

CREATE TABLE IF NOT EXISTS contribution_policy (
  -- workspace_id is the PK, not a surrogate: exactly one policy per workspace, enforced by the shape.
  workspace_id       uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contribute_enabled boolean NOT NULL DEFAULT false,
  -- Fields this workspace will never contribute even when contribution is ON. Empty = the co-op-safe default
  -- boundary applies unchanged; this only ever SUBTRACTS from what would be shared.
  never_share_fields text[] NOT NULL DEFAULT '{}',
  -- The consent record for turning it ON (09 rule 5: logged and revocable). Kept on the row rather than in a
  -- separate log because the question asked at read time is always "is it on, and under which version".
  policy_version     varchar(20) NOT NULL DEFAULT 'v1',
  enabled_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  enabled_at         timestamptz,
  revoked_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- An enabled policy must say who turned it on and when. Consent with no actor is not a consent record, and
  -- a CHECK is the only thing that keeps it true when a future writer forgets.
  CONSTRAINT contribution_policy_enabled_is_attributed
    CHECK (contribute_enabled = false OR (enabled_by_user_id IS NOT NULL AND enabled_at IS NOT NULL))
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS contribution_exclusion (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind               varchar(20) NOT NULL,
  -- kind='domain' only. citext so the match is case-insensitive without lower() — the same posture
  -- master_companies.primary_domain already uses, so the two compare cleanly.
  domain             citext,
  account_id         uuid REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id         uuid REFERENCES contacts(id) ON DELETE CASCADE,
  -- Why it was excluded. Free text, shown back to the admin who has to review the list a year later.
  note               varchar(200),
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contribution_exclusion_kind_enum CHECK (kind IN ('domain','account','contact')),
  -- Exactly one target column populated, matching the kind. Without this a row can claim kind='domain' while
  -- carrying only an account_id, and the reader silently excludes nothing — a deny list that quietly fails
  -- open is worse than no deny list, because the customer believes it is working.
  CONSTRAINT contribution_exclusion_target CHECK (
    (kind = 'domain'  AND domain IS NOT NULL AND account_id IS NULL AND contact_id IS NULL) OR
    (kind = 'account' AND account_id IS NOT NULL AND domain IS NULL AND contact_id IS NULL) OR
    (kind = 'contact' AND contact_id IS NOT NULL AND domain IS NULL AND account_id IS NULL)
  )
);
--> statement-breakpoint

-- One row per target per workspace. Partial uniques rather than one composite: the three kinds populate
-- different columns, so a single UNIQUE over all of them would let NULLs defeat it.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_contribution_exclusion_domain
  ON contribution_exclusion (workspace_id, domain) WHERE kind = 'domain';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_contribution_exclusion_account
  ON contribution_exclusion (workspace_id, account_id) WHERE kind = 'account';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_contribution_exclusion_contact
  ON contribution_exclusion (workspace_id, contact_id) WHERE kind = 'contact';
--> statement-breakpoint

-- The read the backfill does: every exclusion for one workspace, in one trip. The PK is a uuid so it serves
-- nothing here; this index is what keeps the per-batch policy load off a sequential scan.
CREATE INDEX IF NOT EXISTS idx_contribution_exclusion_workspace
  ON contribution_exclusion (workspace_id, kind);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS crm_object_contribution (
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id      uuid NOT NULL REFERENCES crm_connections(id) ON DELETE CASCADE,
  object_type        varchar(20) NOT NULL,
  contribute_enabled boolean NOT NULL DEFAULT false,
  enabled_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  enabled_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, object_type),
  -- Mirrors crm_field_mappings.object_type. Kept as its own CHECK rather than an FK to that table because a
  -- customer may exclude an object they have not mapped a single field of yet.
  CONSTRAINT crm_object_contribution_object_enum
    CHECK (object_type IN ('contact','account','lead','deal')),
  CONSTRAINT crm_object_contribution_enabled_is_attributed
    CHECK (contribute_enabled = false OR (enabled_by_user_id IS NOT NULL AND enabled_at IS NOT NULL))
);

-- DOWN (manual — safe while nothing reads these; all three start empty):
--   DROP TABLE crm_object_contribution;
--   DROP TABLE contribution_exclusion;
--   DROP TABLE contribution_policy;
