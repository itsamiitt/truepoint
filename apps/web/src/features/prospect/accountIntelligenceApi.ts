// accountIntelligenceApi.ts — the typed client for the Layer-0 read surface (0108).
//
// `relationship` is a REQUIRED argument here for the same reason it is required on the wire: "what does this
// company build" and "what does it run" are different facts from different tables, and there is no call
// shape in this module that returns them merged. Types come from @leadwolf/types, so the client cannot drift
// from what the API validates on egress.
"use client";

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type {
  AccountTechnologiesResponse,
  ContactEducationResponse,
  ContactEmploymentResponse,
  ContactProvenanceResponse,
  OrgTechnologyRelationship,
} from "@leadwolf/types";
import { toApiError } from "./api";

export async function fetchAccountTechnologies(
  accountId: string,
  relationship: OrgTechnologyRelationship,
): Promise<AccountTechnologiesResponse> {
  // `fields=vendors` on the uses read expands each technology's creator — the second typed hop that answers
  // "…and who built the tools they run". Free on the develops read, so it is only asked for where it means
  // something.
  const fields = relationship === "uses" ? "&fields=vendors" : "";
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/accounts/${accountId}/technologies?relationship=${relationship}${fields}`,
  );
  if (!res.ok) throw await toApiError(res, "Could not load company technology");
  return (await res.json()) as AccountTechnologiesResponse;
}

/**
 * Where this person studied — the other half of the person→organization graph (employment is already on the
 * contact record). Carries no contact values; `completed` arrives DERIVED from the end date, so the client
 * never re-implements the alumnus rule.
 */
export async function fetchContactEducation(contactId: string): Promise<ContactEducationResponse> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/contacts/${contactId}/education`);
  if (!res.ok) throw await toApiError(res, "Could not load education");
  return (await res.json()) as ContactEducationResponse;
}

/**
 * Why we believe what we hold — bands, recency and corroboration counts, free on a record you already own.
 * Fetched on demand (drawer/popover open), never per grid row: this is one request per record, not per cell.
 */
export async function fetchContactProvenance(
  contactId: string,
): Promise<ContactProvenanceResponse> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/contacts/${contactId}/provenance`);
  if (!res.ok) throw await toApiError(res, "Could not load provenance");
  return (await res.json()) as ContactProvenanceResponse;
}

/** Career history from the graph. Title/dates are usually absent today — render a list, not a timeline. */
export async function fetchContactEmployment(
  contactId: string,
): Promise<ContactEmploymentResponse> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/contacts/${contactId}/employment`);
  if (!res.ok) throw await toApiError(res, "Could not load employment");
  return (await res.json()) as ContactEmploymentResponse;
}
