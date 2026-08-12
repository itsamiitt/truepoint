// The ONLY module that talks HTTP. Components call these typed functions;
// nothing else constructs a URL or reads a response body.

const BASE = (globalThis as { CASCADE_API_BASE?: string }).CASCADE_API_BASE ?? "/v1";

export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
}

export class ApiError extends Error {
  readonly problem: Problem;
  constructor(problem: Problem) {
    super(problem.title);
    this.problem = problem;
  }
}

async function request<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: "application/json" } });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(
      (body as Problem | null) ?? {
        type: "about:blank",
        title: "The request failed.",
        status: res.status,
        code: "unknown_error",
      },
    );
  }
  return body as T;
}

export interface OrganizationDto {
  org_id: string;
  org_kind: string;
  legal_name: string;
  display_name: string | null;
  primary_domain: string | null;
  country_code: string | null;
  confidence: number;
  aliases?: { alias: string; alias_kind: string }[];
  identifiers?: { id_type: string; id_value: string }[];
}

export interface TechEdgeDto {
  rel_id: string;
  technology: {
    technology_id: string;
    canonical_name: string;
    tech_kind: string;
    category_path: string | null;
  };
  relationship: string;
  confidence: number;
  valid_from: string;
  valid_to: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  detection_method: string | null;
  detected_on_domain: string | null;
  is_primary_product: boolean | null;
  creator?: { org_id: string; display_name: string | null; legal_name: string };
}

export interface PersonDto {
  person_id: string;
  full_name: string;
  headline: string | null;
  current_title: string | null;
  confidence: number;
}

export interface EvidenceDto {
  edge_id: string;
  edge_kind: string;
  fused_confidence: number;
  attestations: {
    source_id: string;
    source_class: string;
    confidence: number;
    raw_assertion: string | null;
    seen_at: string;
  }[];
}

export const api = {
  identifyOrganization: (name: string) =>
    request<{
      matched_on: string;
      match_type: string;
      matches: { match_confidence: number; organization: OrganizationDto }[];
    }>(`/organizations/identify?name=${encodeURIComponent(name)}`),

  organization: (orgId: string) =>
    request<{ organization: OrganizationDto }>(
      `/organizations/${orgId}?fields=aliases,identifiers`,
    ),

  /** relationship is required by the contract — it is a parameter here, never a default. */
  technologies: (
    orgId: string,
    relationship: "develops" | "uses",
    opts: { asOf?: string; withVendors?: boolean } = {},
  ) => {
    const params = new URLSearchParams({ relationship, limit: "100" });
    if (opts.asOf) params.set("as_of", opts.asOf);
    if (opts.withVendors) params.set("fields", "vendors");
    return request<{ organization_id: string; relationship: string; results: TechEdgeDto[] }>(
      `/organizations/${orgId}/technologies?${params}`,
    );
  },

  peopleAt: (orgId: string) =>
    request<{
      results: {
        person: PersonDto;
        position: { position_id: string; title: string | null; relationship: string };
      }[];
    }>(`/organizations/${orgId}/people?relationship=employee&current=true&limit=100`),

  alumniOf: (orgId: string) =>
    request<{
      results: {
        person: PersonDto;
        education: { education_id: string; degree: string | null; ended_year: number | null };
      }[];
    }>(`/organizations/${orgId}/people?edge=education&education_status=completed&limit=100`),

  evidence: (edgeId: string) => request<EvidenceDto>(`/evidence/${edgeId}`),
};
