// requestHash.ts — the enrichment cache key (06 §5): sha256 over the provider-independent, NORMALIZED
// request so trivially different requests (case, whitespace, key order) share one cache entry.

import { createHash } from "node:crypto";
import type { EnrichRequest } from "./providerPort.ts";

function normalized(req: EnrichRequest): string {
  const subject = {
    fullName: req.subject.fullName?.trim().toLowerCase() ?? "",
    companyDomain: req.subject.companyDomain?.trim().toLowerCase() ?? "",
    companyName: req.subject.companyName?.trim().toLowerCase() ?? "",
    linkedinUrl: req.subject.linkedinUrl?.trim().toLowerCase() ?? "",
    email: req.subject.email?.trim().toLowerCase() ?? "",
  };
  return JSON.stringify({ entityType: req.entityType, fields: [...req.fields].sort(), subject });
}

/** 32 raw bytes for the (workspace, request) cache unique. Workspace scoping comes from the column. */
export function requestHash(req: EnrichRequest): Uint8Array {
  return createHash("sha256").update(normalized(req), "utf8").digest();
}
