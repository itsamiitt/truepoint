// api.ts — the api-usage backend seam (ADR-0049). One authenticated read of the tenant's own usage rollup.
//
// `available` follows the house degradation convention: a 404/501 means "not wired yet", surfaced as
// available:false so the card renders a connect state instead of an error. That matters here more than
// usually — this endpoint ships behind PUBLIC_DATA_API_ENABLED's sibling work, and a deployment that has the
// dashboard but not the API should say so rather than look broken.
//
// A zero-usage tenant is NOT unavailable. It is available with zero, and the card must say "no calls yet"
// rather than "not connected" — the difference is whether the customer's next step is to integrate or to
// wait.

import { fetchWithAuth } from "@/lib/authClient";
import { isUnavailable } from "@/lib/maybeList";
import { problemMessage } from "@/lib/problemMessage";
import { API_BASE } from "@/lib/publicConfig";
import type { ApiUsageResponse } from "@leadwolf/types";

const API_USAGE = `${API_BASE}/api/v1/tenants/me/api-usage`;

export interface ApiUsageFeed {
  available: boolean;
  usage: ApiUsageResponse | null;
}

export async function fetchApiUsage(days: number): Promise<ApiUsageFeed> {
  const res = await fetchWithAuth(`${API_USAGE}?days=${days}`);
  if (isUnavailable(res.status)) return { available: false, usage: null };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load API usage"));
  return { available: true, usage: (await res.json()) as ApiUsageResponse };
}
