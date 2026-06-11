// providerPort.ts — the provider-agnostic enrichment contract (06 §3). core OWNS the port; adapters in
// packages/integrations implement it (16 §5 direction: integrations → core). The engine never knows which
// vendor answered — only the contract.

import type { EnrichCapability, EnrichField } from "@leadwolf/types";

export interface EnrichSubject {
  fullName?: string;
  companyDomain?: string;
  companyName?: string;
  linkedinUrl?: string;
  email?: string;
}

export interface EnrichRequest {
  workspaceId: string; // results write into THIS workspace's copies only
  entityType: "contact" | "account";
  fields: EnrichField[];
  subject: EnrichSubject;
  region?: string;
}

export interface ProviderFieldResult {
  field: EnrichField;
  value: string;
  confidence?: number; // ∈ [0,1]
}

export interface ProviderResult {
  fields: ProviderFieldResult[];
  rawPayload: unknown; // stored verbatim → source_imports.raw_data
  costMicros: number;
  status: "hit" | "miss" | "rate_limited" | "error";
}

export interface EnrichmentProvider {
  name: string;
  capabilities: EnrichCapability[];
  /** Static trust weight ∈ [0,1] and expected cost — inputs to the waterfall ordering (06 §4). */
  trust: number;
  estimateCostMicros(req: EnrichRequest): number;
  enrich(req: EnrichRequest): Promise<ProviderResult>;
}
