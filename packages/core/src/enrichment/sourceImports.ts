// sourceImports.ts — one source_imports provenance row PER WINNING PROVIDER (waterfall v2). v1 wrote one
// row for the single winning provider; per-field wins mean several providers can contribute to one run,
// and each contribution needs its own raw-payload provenance row under its own source name.
//
// The sourceName CHECK guard: a provider whose name is not in the closed sourceName vocabulary gets NO
// row (the enrichContact.ts:202 posture) — but since 0109 every shipped adapter (apollo, zoominfo,
// clearbit, pdl, coresignal) IS in the vocabulary, a skip here means a NEW adapter landed without its
// enum member, which the returned map makes visible to tests.

import { type Tx, sourceImportRepository } from "@leadwolf/db";
import { sourceName as sourceNameEnum } from "@leadwolf/types";

export interface AppendSourceImportsInput {
  scope: { tenantId: string; workspaceId: string };
  contactId: string;
  requestedByUserId: string | null;
  /** The winning provider names, one source_imports row each. */
  providers: string[];
  rawPayloadByProvider: ReadonlyMap<string, unknown>;
}

/** Append one row per winning provider; returns provider → source_imports id for the channel writes. */
export async function appendSourceImports(
  tx: Tx,
  input: AppendSourceImportsInput,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const provider of input.providers) {
    const parsed = sourceNameEnum.safeParse(provider);
    if (!parsed.success) continue; // unknown adapter name — no provenance row (see header)
    const id = await sourceImportRepository.append(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      contactId: input.contactId,
      importedByUserId: input.requestedByUserId,
      sourceName: parsed.data,
      rawData: (input.rawPayloadByProvider.get(provider) ?? {}) as Record<string, unknown>,
    });
    ids.set(provider, id);
  }
  return ids;
}
