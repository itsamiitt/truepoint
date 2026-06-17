// api.ts — the Tenant ▸ Organization backend seam: authenticated calls (fetchWithAuth, ADR-0016) to the
// documented tenant routes. A 404/501 means "not built yet" — surfaced as null / available:false so the panels
// show disabled/empty states instead of errors. No fabricated workspaces, no fake members, no fake saves.
//
//   GET   /settings/tenant            → organization identity (name, logo, region)   (09 §3, 12 §4)
//   PUT   /settings/tenant            → save organization identity
//   GET   /workspaces                 → tenant workspaces (create/archive)            (09 §3)
//   GET   /settings/tenant/members    → tenant-wide members directory                (09 §3, 12 §4)

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type {
  MembersSummary,
  Organization,
  TenantMember,
  TenantWorkspace,
  WorkspacesFeed,
} from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

function notBuilt(status: number): boolean {
  return status === 404 || status === 501;
}

export async function fetchOrganization(): Promise<Organization | null> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/settings/tenant`);
  if (notBuilt(res.status)) return null;
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load organization settings"));
  return (await res.json()) as Organization;
}

export async function saveOrganization(patch: Partial<Organization>): Promise<{ ok: boolean }> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/settings/tenant`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (notBuilt(res.status)) return { ok: false };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not save organization settings"));
  return { ok: true };
}

export async function fetchWorkspaces(): Promise<WorkspacesFeed> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/workspaces`);
  if (notBuilt(res.status)) return { available: false, workspaces: [] };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load workspaces"));
  const body = (await res.json()) as { workspaces?: TenantWorkspace[] };
  return { available: true, workspaces: body.workspaces ?? [] };
}

export async function fetchMembersSummary(): Promise<MembersSummary> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/settings/tenant/members?limit=5`);
  if (notBuilt(res.status)) {
    return { available: false, total: 0, activeCount: 0, invitedCount: 0, sample: [] };
  }
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load members directory"));
  const body = (await res.json()) as {
    total?: number;
    activeCount?: number;
    invitedCount?: number;
    members?: TenantMember[];
  };
  const sample = body.members ?? [];
  return {
    available: true,
    total: body.total ?? sample.length,
    activeCount: body.activeCount ?? sample.filter((m) => m.status === "active").length,
    invitedCount: body.invitedCount ?? sample.filter((m) => m.status === "invited").length,
    sample,
  };
}
