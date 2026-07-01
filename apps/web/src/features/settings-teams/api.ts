// api.ts — the settings-teams backend seam (Part D): authenticated calls (fetchWithAuth) to /api/v1/teams —
// workspace-scoped team CRUD + roster (add-by-email). GROUPING ONLY; nothing here affects record access.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { TeamMemberView, TeamView } from "@leadwolf/types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

export async function fetchTeams(): Promise<TeamView[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/teams`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load teams"));
  return ((await res.json()) as { teams: TeamView[] }).teams;
}

export async function createTeam(name: string, description?: string): Promise<void> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/teams`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, ...(description ? { description } : {}) }),
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not create the team"));
}

export async function deleteTeam(id: string): Promise<void> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/teams/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not delete the team"));
}

export async function fetchTeamMembers(id: string): Promise<TeamMemberView[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/teams/${encodeURIComponent(id)}/members`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load the roster"));
  return ((await res.json()) as { members: TeamMemberView[] }).members;
}

export async function addTeamMember(id: string, email: string): Promise<void> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/teams/${encodeURIComponent(id)}/members`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not add the member"));
}

export async function removeTeamMember(id: string, userId: string): Promise<void> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/teams/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not remove the member"));
}

/** Workspace member emails for the add-member suggestions (best-effort — empty on any error). */
export async function fetchWorkspaceMemberEmails(): Promise<string[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/workspaces/current/members`);
  if (!res.ok) return [];
  const body = (await res.json()) as { members?: { email: string }[] };
  return (body.members ?? []).map((m) => m.email);
}
