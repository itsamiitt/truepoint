// api.ts — the Sales Navigator slice's data access (05 §5, M7): typed, authenticated calls to apps/api via the
// in-memory access token (fetchWithAuth, ADR-0016). HITL only — a human pastes the link; the UI never fetches
// or automates against LinkedIn. The slice's only seam to the backend.

import { fetchWithAuth } from "@/lib/authClient";
import { problemMessage } from "@/lib/problemMessage";
import { API_BASE } from "@/lib/publicConfig";
import type { SalesNavCaptureResult, SalesNavLinkDTO, SalesNavLinkRequest } from "@leadwolf/types";

/** GET /sales-navigator/links — the workspace's captured links, newest first. No PII; workspace-scoped. */
export async function fetchLinks(): Promise<SalesNavLinkDTO[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/sales-navigator/links`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load captured links"));
  const data = (await res.json()) as { links: SalesNavLinkDTO[] };
  return data.links;
}

/**
 * POST /sales-navigator/links — capture one pasted link. Dedups on (workspace_id, url): a re-paste returns
 * `deduped:true` (status 200) onto the existing row instead of creating a copy; a fresh capture is 201.
 */
export async function captureLink(body: SalesNavLinkRequest): Promise<SalesNavCaptureResult> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/sales-navigator/links`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not capture link"));
  return (await res.json()) as SalesNavCaptureResult;
}

/** DELETE /sales-navigator/links/:id — remove one captured link (204 on success). */
export async function deleteLink(id: string): Promise<void> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/sales-navigator/links/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not remove link"));
}
