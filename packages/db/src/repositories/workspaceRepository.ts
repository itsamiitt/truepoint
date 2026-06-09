// workspaceRepository.ts — data access for `workspaces` (workspaces domain): the active workspaces a user
// can access within a tenant. Runs under withTenantTx so RLS scopes the read to the tenant (03 §9) — the
// workspace-selection step during login uses it before any workspace GUC is set.

import { and, eq } from "drizzle-orm";
import { withTenantTx } from "../client.ts";
import { workspaceMembers, workspaces } from "../schema/auth.ts";

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: string;
}

export const workspaceRepository = {
  async listForUser(tenantId: string, userId: string): Promise<WorkspaceSummary[]> {
    return withTenantTx({ tenantId }, async (tx) => {
      const rows = await tx
        .select({ id: workspaces.id, name: workspaces.name, role: workspaceMembers.role })
        .from(workspaceMembers)
        .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
        .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, "active")));
      return rows.map((r) => ({ id: r.id, name: r.name, role: r.role }));
    });
  },
};
