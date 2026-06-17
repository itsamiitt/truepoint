// api.ts — the Inbox slice's only backend seam: authenticated calls (fetchWithAuth, ADR-0016) to the documented
// /inbox + /tasks routes. The reply/task backends are an M9 gate, so a 404/501 is treated as "not built yet"
// (available:false) — the UI then shows empty/connect states rather than an error. No fabricated data, no fake sends.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { InboxFeed, InboxFilter, InboxThread, TaskFeed, TaskStatus } from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

/** A route that isn't built yet answers 404/501 — that's "no data here", not a failure to surface. */
function notBuilt(status: number): boolean {
  return status === 404 || status === 501;
}

export async function fetchThreads(filter: InboxFilter): Promise<InboxFeed> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/inbox?filter=${encodeURIComponent(filter)}`);
  if (notBuilt(res.status)) return { available: false, threads: [] };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load your inbox"));
  const body = (await res.json()) as { threads?: InboxThread[] };
  return { available: true, threads: body.threads ?? [] };
}

export async function fetchThread(id: string): Promise<InboxThread | null> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/inbox/${id}`);
  if (notBuilt(res.status)) return null;
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load the conversation"));
  return (await res.json()) as InboxThread;
}

/** Assign / snooze / mark done. Returns {ok:false} when the backend isn't built yet (caller toasts gently). */
export async function updateThread(
  id: string,
  patch: { assigneeId?: string | null; status?: "done" | "snoozed" | "open" },
): Promise<{ ok: boolean }> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/inbox/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (notBuilt(res.status)) return { ok: false };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not update the conversation"));
  return { ok: true };
}

/** Send a quick reply. Returns {sent:false} when sending isn't wired yet (no fake send). */
export async function sendReply(id: string, body: string): Promise<{ sent: boolean }> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/inbox/${id}/reply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });
  if (notBuilt(res.status)) return { sent: false };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not send your reply"));
  return { sent: true };
}

export async function fetchTasks(): Promise<TaskFeed> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/tasks`);
  if (notBuilt(res.status)) return { available: false, tasks: [] };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load your tasks"));
  const body = (await res.json()) as { tasks?: TaskFeed["tasks"] };
  return { available: true, tasks: body.tasks ?? [] };
}

export async function updateTask(id: string, status: TaskStatus): Promise<{ ok: boolean }> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/tasks/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (notBuilt(res.status)) return { ok: false };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not update the task"));
  return { ok: true };
}
