-- 0093_entitlement.sql — resolved per-tenant feature caps (06-roadmap Phase 1: "Metering: usage events +
-- tier-entitlement stub (Free caps enforced) so the freemium tiers switch on cleanly later"). EXPAND ONLY:
-- created empty, read by nothing until requireEntitlement lands and ENTITLEMENTS_ENABLED is flipped.
--
-- A CAP LAYER ABOVE CREDITS, NOT A REPLACEMENT FOR THEM (decision D2). The shipped reveal-credit ledger stays
-- exactly as it is: credits remain the internal settlement unit, entitlements answer a different question —
-- "is this tenant ALLOWED to do this, this period". Reconciling the two in code would touch the money loop,
-- the ledger recon worker, Stripe webhooks and the subscription grant worker, none of it reversible by a flag,
-- which is precisely why D2 rules it out.
--
-- WHAT THIS DOES NOT ADD, so a later reader does not go looking:
--   • no `subscription` table — `subscriptions` exists and is authoritative
--   • no `tier` column — the tier IS subscriptions.plan_template_key; a second one is the rip-and-replace trap
--   • no usage rollup counters — the count comes from idx_usage_event_cap. Counters get added when a slow log
--     says so, not in advance.
--
-- `source` sits in the PRIMARY KEY on purpose. Phase 3's Community tier grants expanded caps for keeping a
-- contribution channel active; those grants must land somewhere that is NOT the staff-authored plan_templates
-- catalog, and they must be able to coexist with the plan's own row for the same key rather than overwrite it.
-- Resolution takes the most permissive live row per (tenant, key) — which is what lets Community access be
-- withdrawn by expiring one row without touching what the tenant paid for.

CREATE TABLE IF NOT EXISTS entitlement (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key        varchar(50) NOT NULL,
  -- NULL = unlimited. Distinct from 0, which is a real and meaningful cap (the feature is off for this tenant).
  cap        integer,
  period     varchar(20),
  source     varchar(20) NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  PRIMARY KEY (tenant_id, key, source),
  CONSTRAINT entitlement_source_enum CHECK (source IN ('plan','community','grant','staff')),
  CONSTRAINT entitlement_period_enum CHECK (period IS NULL OR period IN ('month','lifetime')),
  CONSTRAINT entitlement_cap_non_negative CHECK (cap IS NULL OR cap >= 0)
);
--> statement-breakpoint

-- The resolver reads every live row for a tenant at once, so the PK's leading tenant_id already serves it.
-- This partial index serves the expiry sweep instead — Community grants are the rows that actually expire.
CREATE INDEX IF NOT EXISTS idx_entitlement_expiring
  ON entitlement (expires_at)
  WHERE expires_at IS NOT NULL;

-- DOWN (manual — safe while ENTITLEMENTS_ENABLED is off, since nothing reads the table):
--   DROP TABLE entitlement;
