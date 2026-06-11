// enrichment.ts — the `enrichment` queue processor (06 §4): injects the configured vendor adapters
// (packages/integrations) into core's enrichContact. Provider I/O lives here on the worker, never on the
// api request thread or inside the reveal lock window.

import { type EnrichContactResult, enrichContact } from "@leadwolf/core";
import { defaultProviders } from "@leadwolf/integrations";
import type { EnrichField } from "@leadwolf/types";
import type { Job } from "bullmq";

export const ENRICHMENT_QUEUE = "enrichment";

export interface EnrichmentJobData {
  tenantId: string;
  workspaceId: string;
  contactId: string;
  fields: EnrichField[];
  requestedByUserId?: string | null;
}

export async function processEnrichment(job: Job<EnrichmentJobData>): Promise<EnrichContactResult> {
  const { tenantId, workspaceId, contactId, fields, requestedByUserId } = job.data;
  return enrichContact({
    scope: { tenantId, workspaceId },
    contactId,
    fields,
    providers: defaultProviders(),
    requestedByUserId,
  });
}
