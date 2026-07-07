// api.ts — the Review slice's data access: a typed, authenticated GET against the forge-api `/bff/review-tasks`
// surface via the in-memory access token (fetchWithAuth, ADR-0016). Reads only; the console never touches a DB.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { ReviewTask, ReviewTasksResponse } from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

/** GET /bff/review-tasks — the queue of captures flagged for human review. */
export async function fetchReviewTasks(): Promise<ReviewTask[]> {
  const res = await fetchWithAuth(`${API_BASE}/bff/review-tasks`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load review tasks"));
  const body = (await res.json()) as ReviewTasksResponse;
  return body.tasks;
}
