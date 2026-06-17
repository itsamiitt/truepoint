// api.ts — the Workspace-settings backend seam: authenticated calls (fetchWithAuth, ADR-0016) to the documented
// /workspaces routes. A 404/501 means "not built yet" — surfaced as null / available:false so the panels show
// disabled/empty states instead of errors. No fabricated members, no fake saves.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { MembersFeed, WorkspaceGeneral, WorkspaceMember, WorkspaceRole } from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

function notBuilt(status: number): boolean {
  return status === 404 || status === 501;
}

export async function fetchWorkspace(): Promise<WorkspaceGeneral | null> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/workspaces/current`);
  if (notBuilt(res.status)) return null;
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load workspace settings"));
  return (await res.json()) as WorkspaceGeneral;
}

export async function saveWorkspace(patch: Partial<WorkspaceGeneral>): Promise<{ ok: boolean }> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/workspaces/current`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (notBuilt(res.status)) return { ok: false };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not save workspace settings"));
  return { ok: true };
}

export async function fetchMembers(): Promise<MembersFeed> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/workspaces/current/members`);
  if (notBuilt(res.status)) return { available: false, members: [] };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load members"));
  const body = (await res.json()) as { members?: WorkspaceMember[] };
  return { available: true, members: body.members ?? [] };
}

export async function inviteMember(email: string, role: WorkspaceRole): Promise<{ ok: boolean }> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/workspaces/current/members`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, role }),
  });
  if (notBuilt(res.status)) return { ok: false };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not send the invite"));
  return { ok: true };
}

export async function updateMemberRole(id: string, role: WorkspaceRole): Promise<{ ok: boolean }> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/workspaces/current/members/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role }),
  });
  if (notBuilt(res.status)) return { ok: false };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not update the role"));
  return { ok: true };
}

export async function removeMember(id: string): Promise<{ ok: boolean }> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/workspaces/current/members/${id}`, {
    method: "DELETE",
  });
  if (notBuilt(res.status)) return { ok: false };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not remove the member"));
  return { ok: true };
}
