// lookupInterest.ts — the "interested workspaces" set that lets the background 30-day sweep notify the
// extension when a URL a user just viewed lands or refreshes (chrome-extension/15 §13, option D). The set is
// a TTL'd Redis set per CANONICAL url: `/lookup` SADDs the viewing workspace, and `linkedinLinkFetchSweep`,
// after a landing, emits `contact.lookup_updated` to each interested workspace and clears the set. No schema
// change — a never-consumed interest just expires. Chose this over threading a workspace through the fetch
// (there is no per-URL fetch job: the sweep drains the global registry) or a persistent interested-workspaces
// table (a migration on a billions-scale table for a nice-to-have push).
//
// These helpers are PURE — key/member encoding and the PII-free payload derived from the URL. The Redis reads
// and the outbox append are side effects the sweep owns (the worker is where the "who's interested" state and
// the landing both live).
import type { ContactLookupUpdatedPayload } from "@leadwolf/types";
import { linkedinUrlKey } from "./linkedinUrlKey.ts";

/** How long a lookup's interest lives — a viewing session's fetch window. Past this the user has moved on and
 *  the poll safety net covers a late landing, so a never-consumed interest must not linger. */
export const LOOKUP_INTEREST_TTL_S = 5 * 60;

/** The per-URL interested-workspaces set key, keyed by the CANONICAL url (`linkedinUrlKey.normalizedUrl`) so a
 *  profile viewed as a lead link and later as its public slug share one set — the same collapse the fetch
 *  registry does. */
export function lookupInterestKey(normalizedUrl: string): string {
  return `lookup:interested:${normalizedUrl}`;
}

/** A set member is "<tenantId>:<workspaceId>" — both are needed to append a workspace-scoped outbox row, and
 *  `/lookup` has both from the verified token. Tenant/workspace ids are UUIDs (no colons), so the join is
 *  unambiguous. */
export function lookupInterestMember(tenantId: string, workspaceId: string): string {
  return `${tenantId}:${workspaceId}`;
}

/** Inverse of `lookupInterestMember`; null on a malformed member (defensive — a set could hold a stale shape
 *  written by an older build). */
export function parseLookupInterestMember(
  member: string,
): { tenantId: string; workspaceId: string } | null {
  const parts = member.split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { tenantId: parts[0], workspaceId: parts[1] };
}

/** Build the PII-free event payload for a landed URL, or null when the URL is not a person we can address (the
 *  extension's profile card is person-only today; company cards are X07). The identifiers are the free
 *  addressing keys — never channel data. */
export function lookupUpdatedPayload(
  normalizedUrl: string,
  outcome: ContactLookupUpdatedPayload["outcome"],
): ContactLookupUpdatedPayload | null {
  const key = linkedinUrlKey(normalizedUrl);
  if (!key || key.entityKind !== "person" || !key.externalId) return null;
  // A public /in/ url canonicalizes with the slug as externalId (already lowercased by linkedinUrlKey); a
  // sales-nav person keeps its opaque, case-sensitive lead id.
  return key.normalizedUrl.includes("/in/")
    ? { linkedinPublicId: key.externalId, outcome }
    : { salesNavLeadId: key.externalId, outcome };
}
