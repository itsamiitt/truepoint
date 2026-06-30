// api.ts — the Data-Ops Overview slice's data access: a typed, authenticated read against the apps/api
// `/admin/data/*` surface via the in-memory access token (fetchWithAuth, ADR-0016), mirroring the Imports /
// Tenants read slices. The console NEVER touches the database directly — the cross-tenant read goes through the
// audited api endpoint (ADR-0011 / ADR-0032), which gates on the data:read capability. Read-only: this surface
// has no mutations. The slice's only network seam.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { ApprovalRequestView, UpsertValidationRuleInput, ValidationRule } from "@leadwolf/types";
import type {
  DataImportDetail,
  DataOpsOverview,
  EnrichmentRunRow,
  FleetQualityRow,
  VerificationRunRow,
} from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

/** GET /admin/data/overview — the cross-tenant data-ops rollup (counts/tallies only; bounded by the api). */
export async function fetchDataOpsOverview(): Promise<DataOpsOverview> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/data/overview`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load the data-ops overview"));
  return (await res.json()) as DataOpsOverview;
}

/** GET /admin/data/imports/:jobId — one bulk-import job's metadata + per-status chunk tally (counts only, no PII). */
export async function fetchDataImportDetail(jobId: string): Promise<DataImportDetail> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/data/imports/${jobId}`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load the import job"));
  return (await res.json()) as DataImportDetail;
}

/** GET /admin/data/enrichment/runs — recent bulk-enrichment jobs across all tenants (metadata + credit spend). */
export async function fetchEnrichmentRuns(): Promise<EnrichmentRunRow[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/data/enrichment/runs`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load enrichment runs"));
  const body = (await res.json()) as { runs: EnrichmentRunRow[] };
  return body.runs;
}

/** GET /admin/data/verification/runs — recent freshness re-verification runs across all tenants (counts only). */
export async function fetchVerificationRuns(): Promise<VerificationRunRow[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/data/verification/runs`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load verification runs"));
  const body = (await res.json()) as { runs: VerificationRunRow[] };
  return body.runs;
}

/** GET /admin/data/quality/snapshots — recent per-workspace data-quality snapshots across all tenants (counts). */
export async function fetchFleetQuality(): Promise<FleetQualityRow[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/data/quality/snapshots`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load the fleet quality view"));
  const body = (await res.json()) as { snapshots: FleetQualityRow[] };
  return body.snapshots;
}

/** GET /admin/data/approvals — the pending maker-checker review queue (data:review). */
export async function fetchPendingApprovals(): Promise<ApprovalRequestView[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/data/approvals`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load the approvals queue"));
  const body = (await res.json()) as { approvals: ApprovalRequestView[] };
  return body.approvals;
}

/** POST /admin/data/approvals/:id/{approve|reject} — decide a pending request. The server enforces
 *  requester != approver (separation of duties); a self-decision returns 403. */
async function decide(id: string, action: "approve" | "reject", reason: string): Promise<void> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/data/approvals/${encodeURIComponent(id)}/${action}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason }),
    },
  );
  if (!res.ok) throw new Error(await problemMessage(res, `Could not ${action} the request`));
}

export function approveRequest(id: string, reason: string): Promise<void> {
  return decide(id, "approve", reason);
}

export function rejectRequest(id: string, reason: string): Promise<void> {
  return decide(id, "reject", reason);
}

/** GET /admin/data/validation/rules — the global data-quality rule set (built-in checks + custom). data:read. */
export async function fetchValidationRules(): Promise<ValidationRule[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/data/validation/rules`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load validation rules"));
  const body = (await res.json()) as { rules: ValidationRule[] };
  return body.rules;
}

/** POST /admin/data/validation/rules — create a custom rule (data:manage). */
export async function createValidationRule(input: UpsertValidationRuleInput): Promise<void> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/data/validation/rules`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not create the rule"));
}

/** PUT /admin/data/validation/rules/:id — update a custom rule (data:manage). */
export async function updateValidationRule(id: string, input: UpsertValidationRuleInput): Promise<void> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/data/validation/rules/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not update the rule"));
}

/** POST /admin/data/validation/rules/:id/toggle — enable/disable a custom rule (data:manage). */
export async function toggleValidationRule(id: string, enabled: boolean): Promise<void> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/data/validation/rules/${encodeURIComponent(id)}/toggle`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    },
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not change the rule"));
}

/** DELETE /admin/data/validation/rules/:id — delete a custom rule (data:manage). Built-ins can't be deleted. */
export async function deleteValidationRule(id: string): Promise<void> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/data/validation/rules/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not delete the rule"));
}
