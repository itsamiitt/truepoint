-- entitlement.sql — access model for the resolved per-tenant feature caps (Phase 1 S-09).
--
-- ACCESS MODEL: read-only for the customer app role, exactly the retention_class_policies / feature_flags
-- posture. leadwolf_app must READ its own tenant's entitlements to evaluate a cap in-request, and must NEVER
-- write one — a role that can grant itself an entitlement has no cap at all, which would make the entire
-- enforcement path decorative. Writes happen on the owner / withPlatformTx path: the plan sync, the Stripe
-- subscription hooks, staff grants, and (Phase 3) Community activation.
--
-- THE WRITE WALL IS FORCE RLS PLUS THE ABSENCE OF A WRITE POLICY, not the GRANT below. applyMigrations' [4/4]
-- phase runs AFTER every rls/*.sql and hands leadwolf_app every table privilege via a blanket grant, so a
-- REVOKE here would simply be undone. Under FORCE ROW LEVEL SECURITY a command is denied unless a policy
-- permits it — so a SELECT policy with no INSERT/UPDATE/DELETE counterpart is the actual wall. The GRANT below
-- is documentary and defense-in-depth.
--
-- Tenant-scoped, not workspace-scoped: entitlements are bought and held by the tenant, and every workspace
-- inside it shares them. The GUC is app.current_tenant_id, which withTenantTx sets in both its scoped and
-- workspace-less forms — so a tenant-level request (billing, plan) can still evaluate a cap.

ALTER TABLE entitlement ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlement FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS entitlement_tenant_read ON entitlement;
CREATE POLICY entitlement_tenant_read ON entitlement FOR SELECT
  USING (tenant_id = (SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid));

-- Documentary; the wall is the missing write policy above.
GRANT SELECT ON entitlement TO leadwolf_app;
