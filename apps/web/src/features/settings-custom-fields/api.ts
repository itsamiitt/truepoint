// api.ts — the custom-fields settings backend seam: authenticated calls (fetchWithAuth, ADR-0016) to the
// /api/v1/custom-fields routes. A 404/501 means "not built yet" — surfaced as available:false so the panel
// shows a disabled/empty state instead of an error. No fabricated definitions, no fake saves.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type {
  CreateCustomFieldRequest,
  CustomFieldDefinitionDto,
  CustomFieldEntity,
  UpdateCustomFieldRequest,
} from "@leadwolf/types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

function notBuilt(status: number): boolean {
  return status === 404 || status === 501;
}

export interface DefinitionsFeed {
  available: boolean;
  definitions: CustomFieldDefinitionDto[];
}

export async function fetchDefinitions(entity: CustomFieldEntity): Promise<DefinitionsFeed> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/custom-fields?entity=${entity}&includeArchived=true`,
  );
  if (notBuilt(res.status)) return { available: false, definitions: [] };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load custom fields"));
  const body = (await res.json()) as { definitions?: CustomFieldDefinitionDto[] };
  return { available: true, definitions: body.definitions ?? [] };
}

export async function createDefinition(input: CreateCustomFieldRequest): Promise<{ ok: boolean }> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/custom-fields`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (notBuilt(res.status)) return { ok: false };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not create the custom field"));
  return { ok: true };
}

export async function updateDefinition(
  id: string,
  patch: UpdateCustomFieldRequest,
): Promise<{ ok: boolean }> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/custom-fields/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (notBuilt(res.status)) return { ok: false };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not update the custom field"));
  return { ok: true };
}
