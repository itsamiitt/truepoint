// api.ts — the Plans slice's data access: typed, authenticated calls against the apps/api
// `/admin/pricing/plan-templates` surface via the in-memory access token (fetchWithAuth, ADR-0016). The
// console NEVER touches the database directly — every read/write goes through the audited, pricing:manage-gated
// endpoints.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { PlanTemplate } from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

export interface PlanTemplateInput {
  key: string;
  name: string;
  seatLimit: number;
  workspaceLimit: number | null;
  monthlyCreditGrant: number | null;
  trialBonusCredits: number | null;
  features: Record<string, boolean>;
  sortOrder: number;
}

/** GET /admin/pricing/plan-templates — the full catalog (active + retired). */
export async function fetchPlanTemplates(): Promise<PlanTemplate[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/pricing/plan-templates`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load plan templates"));
  const body = (await res.json()) as { templates: PlanTemplate[] };
  return body.templates;
}

/** PUT /admin/pricing/plan-templates — create or update a template (idempotent on key). */
export async function upsertPlanTemplate(input: PlanTemplateInput): Promise<PlanTemplate> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/pricing/plan-templates`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not save the plan"));
  const body = (await res.json()) as { template: PlanTemplate };
  return body.template;
}

/** POST /admin/pricing/plan-templates/:key/active — offer or retire a template. */
export async function setPlanTemplateActive(key: string, active: boolean): Promise<void> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/pricing/plan-templates/${encodeURIComponent(key)}/active`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active }),
    },
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not update the plan"));
}
