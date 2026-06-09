// api.ts — the import slice's data access: typed, authenticated calls to apps/api. Uses the in-memory
// access token via fetchWithAuth (ADR-0016); never talks to the DB or the auth origin directly. The slice's
// only seam to the backend.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { ColumnMapping, ImportSummary, MaskedContact, SourceName } from "@leadwolf/types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

export async function postImport(args: {
  file: File;
  sourceName: SourceName;
  mapping: ColumnMapping;
}): Promise<ImportSummary> {
  const form = new FormData();
  form.set("file", args.file);
  form.set("sourceName", args.sourceName);
  form.set("mapping", JSON.stringify(args.mapping));
  const res = await fetchWithAuth(`${API_BASE}/api/v1/imports`, { method: "POST", body: form });
  if (!res.ok) throw new Error(await problemMessage(res, "Import failed"));
  return (await res.json()) as ImportSummary;
}

export async function fetchContacts(): Promise<MaskedContact[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/contacts`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load contacts"));
  const data = (await res.json()) as { contacts: MaskedContact[] };
  return data.contacts;
}
