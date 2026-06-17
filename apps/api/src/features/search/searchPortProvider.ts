// searchPortProvider.ts — wire a SearchPort for the current workspace. MVP/interim path (ADR-0002 fallback):
// load the workspace's masked contacts (capped, RLS-scoped) and serve search/suggest/facets from the tested
// in-memory adapter. This is BOUNDED on purpose — discipline §9 forbids loading everything; the candidate
// set is capped at CANDIDATE_CAP. The billions-scale path swaps the OpenSearch/Typesense adapter here behind
// the same SearchPort (ADR-0021/0035) with no route changes.

import { contactRepository } from "@leadwolf/db";
import { createInMemorySearchPort, type IndexedContact } from "@leadwolf/search";
import type { SearchPort } from "@leadwolf/types";

/** Max candidate rows pulled into the in-memory adapter (discipline §9 — never load the whole workspace). */
const CANDIDATE_CAP = 500;

/** Build a workspace-scoped SearchPort over the (capped) masked contact set. */
export async function buildWorkspaceSearchPort(scope: {
  tenantId: string;
  workspaceId: string;
}): Promise<SearchPort> {
  const contacts = await contactRepository.listByWorkspace(scope, CANDIDATE_CAP);
  const indexed: IndexedContact[] = contacts.map((c) => ({ ...c, workspaceId: scope.workspaceId }));
  return createInMemorySearchPort(indexed);
}
