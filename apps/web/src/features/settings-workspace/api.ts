// api.ts — the Workspace-settings backend seam: authenticated calls (fetchWithAuth, ADR-0016) to the documented
// /workspaces routes. A 404/501 means "not built yet" — surfaced as null / available:false so the panels show
// disabled/empty states instead of errors. No fabricated members, no fake saves.

import { fetchWithAuth } from "@/lib/authClient";
import { isUnavailable } from "@/lib/maybeList";
import { problemMessage } from "@/lib/problemMessage";
import { API_BASE } from "@/lib/publicConfig";
import type {
  MembersFeed,
  SessionsFeed,
  WorkspaceGeneral,
  WorkspaceMember,
  WorkspaceRole,
  WorkspaceSession,
} from "./types";

export async function fetchWorkspace(): Promise<WorkspaceGeneral | null> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/workspaces/current`);
  if (isUnavailable(res.status)) return null;
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load workspace settings"));
  return (await res.json()) as WorkspaceGeneral;
}

export async function saveWorkspace(patch: Partial<WorkspaceGeneral>): Promise<{ ok: boolean }> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/workspaces/current`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (isUnavailable(res.status)) return { ok: false };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not save workspace settings"));
  return { ok: true };
}

export async function fetchMembers(): Promise<MembersFeed> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/workspaces/current/members`);
  if (isUnavailable(res.status)) return { available: false, members: [] };
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
  if (isUnavailable(res.status)) return { ok: false };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not send the invite"));
  return { ok: true };
}

export async function updateMemberRole(id: string, role: WorkspaceRole): Promise<{ ok: boolean }> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/workspaces/current/members/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role }),
  });
  if (isUnavailable(res.status)) return { ok: false };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not update the role"));
  return { ok: true };
}

export async function removeMember(id: string): Promise<{ ok: boolean }> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/workspaces/current/members/${id}`, {
    method: "DELETE",
  });
  if (isUnavailable(res.status)) return { ok: false };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not remove the member"));
  return { ok: true };
}

// ── Security ▸ Sessions (G-AUTH-2) ────────────────────────────────────────────────────────────────────
export async function fetchSessions(): Promise<SessionsFeed> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/workspaces/security/sessions`);
  if (isUnavailable(res.status)) return { available: false, sessions: [] };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load sessions"));
  const body = (await res.json()) as { sessions?: WorkspaceSession[] };
  return { available: true, sessions: body.sessions ?? [] };
}

// For the session MUTATIONS the route exists once the GET does, so a 404 is a REAL "already gone / not in
// this workspace" (the core throws NotFoundError) and must surface — only a 501 means "not built yet".
export async function revokeSession(sessionId: string): Promise<{ ok: boolean }> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/workspaces/security/sessions/${encodeURIComponent(sessionId)}/revoke`,
    { method: "POST" },
  );
  if (res.status === 501) return { ok: false };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not revoke the session"));
  return { ok: true };
}

export async function forceReauthMember(userId: string): Promise<{ ok: boolean }> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/workspaces/security/members/${encodeURIComponent(userId)}/force-reauth`,
    { method: "POST" },
  );
  if (res.status === 501) return { ok: false };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not sign the member out"));
  return { ok: true };
}
