// api.ts — the Tenants slice's data access: typed, authenticated reads against the apps/api `/admin/*` surface
// via the in-memory access token (fetchWithAuth, ADR-0016). The console NEVER touches the database directly —
// every cross-tenant read goes through the audited api endpoints (ADR-0011 / ADR-0034). The slice's only seam.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type {
  AccountHold,
  PlanTemplateOption,
  Purchase,
  SupportNote,
  TenantDetail,
  TenantOverview,
  TenantRow,
} from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

export interface TenantsPage {
  tenants: TenantRow[];
  nextCursor: string | null;
}

/** GET /admin/tenants — one keyset page of the directory, optionally filtered by a name/slug search (13a F5). */
export async function fetchTenants(search?: string, cursor?: string): Promise<TenantsPage> {
  const p = new URLSearchParams();
  if (search) p.set("search", search);
  if (cursor) p.set("cursor", cursor);
  const qs = p.toString();
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/tenants${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load tenants"));
  return (await res.json()) as TenantsPage;
}

/** GET /admin/tenants/:id — one org plus its workspaces + members. */
export async function fetchTenantDetail(id: string): Promise<TenantDetail> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/tenants/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load tenant"));
  return (await res.json()) as TenantDetail;
}

/** POST /admin/tenants/:id/suspend — suspend an org (super_admin). Reason is audited. */
export async function suspendTenant(id: string, reason: string): Promise<void> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/tenants/${encodeURIComponent(id)}/suspend`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason }),
    },
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not suspend the tenant"));
}

/** POST /admin/tenants/:id/reactivate — reactivate a suspended org (super_admin). Reason is audited. */
export async function reactivateTenant(id: string, reason: string): Promise<void> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/tenants/${encodeURIComponent(id)}/reactivate`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason }),
    },
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not reactivate the tenant"));
}

/** GET /admin/pricing/plan-templates — the active plan templates, for the plan-override picker. */
export async function fetchActivePlanTemplates(): Promise<PlanTemplateOption[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/pricing/plan-templates`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load plan templates"));
  const body = (await res.json()) as { templates: PlanTemplateOption[] };
  return body.templates.filter((t) => t.active);
}

/** POST /admin/tenants/:id/plan — apply a plan template's entitlements to a tenant (tenants:plan). */
export async function applyTenantPlan(id: string, templateKey: string): Promise<void> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/tenants/${encodeURIComponent(id)}/plan`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ templateKey }),
    },
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not apply the plan"));
}

/** GET /admin/tenants/:id/purchases — the tenant's credit-pack purchases (billing:read). */
export async function fetchTenantPurchases(id: string): Promise<Purchase[]> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/tenants/${encodeURIComponent(id)}/purchases`,
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load purchases"));
  const body = (await res.json()) as { purchases: Purchase[] };
  return body.purchases;
}

/** POST /admin/tenants/:id/purchases/:purchaseId/refund — reverse a purchase (tenants:credits). */
export async function refundPurchase(
  id: string,
  purchaseId: string,
): Promise<{ reversed: number; balanceAfter: number }> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/tenants/${encodeURIComponent(id)}/purchases/${encodeURIComponent(purchaseId)}/refund`,
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not refund the purchase"));
  const body = (await res.json()) as { reversed: number; balanceAfter: number };
  return { reversed: body.reversed, balanceAfter: body.balanceAfter };
}

/** GET /admin/tenants/:id/overview — the customer-360 usage/health aggregate for a tenant. */
export async function fetchTenantOverview(id: string): Promise<TenantOverview> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/tenants/${encodeURIComponent(id)}/overview`,
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load overview"));
  return (await res.json()) as TenantOverview;
}

/** GET /admin/tenants/:id/notes — the staff support notes for a tenant (newest first). */
export async function fetchTenantNotes(id: string): Promise<SupportNote[]> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/tenants/${encodeURIComponent(id)}/notes`,
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load notes"));
  const body = (await res.json()) as { notes: SupportNote[] };
  return body.notes;
}

/** POST /admin/tenants/:id/notes — add a staff support note (super_admin|support). Audited. */
export async function addTenantNote(
  id: string,
  noteBody: string,
  ticketUrl?: string,
): Promise<SupportNote> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/tenants/${encodeURIComponent(id)}/notes`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: noteBody, ...(ticketUrl ? { ticketUrl } : {}) }),
    },
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not add note"));
  const data = (await res.json()) as { note: SupportNote };
  return data.note;
}

/** GET /admin/tenants/:id/holds — the abuse/fraud holds on a tenant (active first). */
export async function fetchTenantHolds(id: string): Promise<AccountHold[]> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/tenants/${encodeURIComponent(id)}/holds`,
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load holds"));
  const body = (await res.json()) as { holds: AccountHold[] };
  return body.holds;
}

/** POST /admin/tenants/:id/holds — place an abuse/fraud hold (super_admin|support). Audited. */
export async function placeTenantHold(
  id: string,
  kind: string,
  reason: string,
): Promise<AccountHold> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/tenants/${encodeURIComponent(id)}/holds`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, reason }),
    },
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not place the hold"));
  const body = (await res.json()) as { hold: AccountHold };
  return body.hold;
}

/** POST /admin/tenants/:id/holds/:holdId/lift — lift an active hold (super_admin|support). Audited. */
export async function liftTenantHold(id: string, holdId: string): Promise<void> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/tenants/${encodeURIComponent(id)}/holds/${encodeURIComponent(holdId)}/lift`,
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not lift the hold"));
}

/** POST /admin/elevations — mint a time-boxed JIT elevation (13a F1) the gated action then consumes. The
 *  console requests this immediately before a suspend / credit action, passing the same reason. */
export async function requestElevation(
  action: "credit.adjust" | "tenant.suspend",
  reason: string,
  targetTenantId: string,
): Promise<void> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/elevations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, reason, targetTenantId }),
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not obtain elevation"));
}

/** POST /admin/tenants/:id/credits — manual signed credit adjustment (super_admin|billing_ops). Returns the
 *  new authoritative balance. A positive delta grants, a negative one debits; both are audited with a reason. */
export async function adjustTenantCredits(
  id: string,
  delta: number,
  reason: string,
): Promise<{ balanceAfter: number }> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/tenants/${encodeURIComponent(id)}/credits`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delta, reason }),
    },
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not adjust credits"));
  const body = (await res.json()) as { balanceAfter: number };
  return { balanceAfter: body.balanceAfter };
}
