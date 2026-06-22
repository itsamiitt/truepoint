// dedup.ts — the contact dedup pass (24 Phase-0.5, data-signals facet). Flags likely-duplicate contacts within
// ONE workspace by writing contacts.duplicate_of_contact_id → the canonical contact, powering the "find/hide
// probable duplicates" search facet. It is a SOFT pass: it only sets a pointer, never merges or deletes rows.
//
// Why a name+domain key (not the exact keys): email_blind_index / linkedin_public_id / sales_nav_lead_id are
// each already UNIQUE per workspace (schema/contacts.ts), so exact-key duplicates can't exist. Cross-source
// duplicates instead show up as the SAME person at the SAME company under different keys — so the dedup key is
// canonicalName + registrableDomain(emailDomain). Both must be present to claim a duplicate (a name alone is too
// weak). Everything runs inside withTenantTx, so RLS guarantees a pointer can never cross workspaces.

import {
  type DedupContactRow,
  type TenantScope,
  contactRepository,
  withTenantTx,
} from "@leadwolf/db";
import { canonicalName, registrableDomain } from "../enrichment/matchKeys.ts";

export interface DuplicateGroup {
  canonicalId: string;
  duplicateIds: string[];
}

export interface RunDedupResult {
  /** Live contacts scanned. */
  scanned: number;
  /** Duplicate groups found (each with ≥1 duplicate beyond the canonical). */
  groups: number;
  /** Contacts newly pointed at a canonical. */
  flagged: number;
  /** Stale pointers cleared before recompute. */
  cleared: number;
}

/** The grouping key for a contact: canonical name @@ registrable company domain. `null` = insufficient signal
 *  (missing a name or a company domain) → the contact is never grouped as a duplicate. */
export function dedupKey(c: DedupContactRow): string | null {
  const name = canonicalName({ firstName: c.firstName, lastName: c.lastName });
  const domain = registrableDomain(c.emailDomain);
  if (!name || !domain) return null;
  return `${name.canonical}@@${domain}`;
}

/** How "complete" a contact record is — the count of populated enrichable fields. Used to prefer the richer
 *  record as the canonical when revealed-status ties. */
export function completenessScore(c: DedupContactRow): number {
  let score = 0;
  if (c.jobTitle) score += 1;
  if (c.linkedinUrl) score += 1;
  if (c.seniorityLevel) score += 1;
  if (c.department) score += 1;
  if (c.locationCountry) score += 1;
  if (c.hasPhone) score += 1;
  return score;
}

/** Pick the canonical (surviving) contact of a duplicate group, deterministically: revealed beats unrevealed
 *  (you've paid for/own it), then the most complete record, then the earliest created, then the lowest id as a
 *  stable final tiebreak (so re-runs are idempotent). */
export function pickCanonical(group: DedupContactRow[]): DedupContactRow {
  return [...group].sort((a, b) => {
    if (a.isRevealed !== b.isRevealed) return a.isRevealed ? -1 : 1;
    const byScore = completenessScore(b) - completenessScore(a);
    if (byScore !== 0) return byScore;
    const byAge = a.createdAt.getTime() - b.createdAt.getTime();
    if (byAge !== 0) return byAge;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0] as DedupContactRow;
}

/** Pure: group contacts by dedup key, and for each group of ≥2 emit the canonical + the duplicates. */
export function computeDuplicateGroups(contacts: DedupContactRow[]): DuplicateGroup[] {
  const byKey = new Map<string, DedupContactRow[]>();
  for (const c of contacts) {
    const key = dedupKey(c);
    if (!key) continue;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(c);
    else byKey.set(key, [c]);
  }
  const groups: DuplicateGroup[] = [];
  for (const members of byKey.values()) {
    if (members.length < 2) continue;
    const canonical = pickCanonical(members);
    const duplicateIds = members.filter((m) => m.id !== canonical.id).map((m) => m.id);
    if (duplicateIds.length > 0) groups.push({ canonicalId: canonical.id, duplicateIds });
  }
  return groups;
}

/**
 * Run the dedup pass for one workspace: read the live contacts, compute duplicate groups, clear stale pointers,
 * and re-point the current duplicates at their canonical — all in ONE workspace-scoped tx (RLS isolation). Safe
 * to run repeatedly (idempotent: clear-then-set converges to the same state). Intended to run off the request
 * thread (the dedup queue worker), e.g. after an import completes or on a schedule.
 */
export async function runDedup(
  scope: TenantScope & { workspaceId: string },
): Promise<RunDedupResult> {
  return withTenantTx(scope, async (tx) => {
    const rows = await contactRepository.listForDedup(tx);
    const groups = computeDuplicateGroups(rows);
    const cleared = await contactRepository.clearDuplicateFlags(tx);
    let flagged = 0;
    for (const g of groups) {
      flagged += await contactRepository.flagDuplicates(tx, g.canonicalId, g.duplicateIds);
    }
    return { scanned: rows.length, groups: groups.length, flagged, cleared };
  });
}
