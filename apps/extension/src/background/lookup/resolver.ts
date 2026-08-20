// resolver.ts — LOOKUP resolution shared by the bus router and the SSE consumer. Owns the ONE warm cache (a
// memory-only singleton: the bus populates it, a pushed update invalidates it, and both agree because it is
// the same object) plus the DB-first resolver. `refreshSubjectFromEvent` is what turns a `contact.lookup_updated`
// push into a fresh SUBJECT_STATUS without a page reload (chrome-extension/15 P2).
import type { SubjectStatus } from "../../shared/types.ts";
import type { RuntimeContext } from "../context.ts";
import { LookupCache } from "./cache.ts";

/** The single warm cache for LOOKUP resolution. Memory-only (dies with the worker → a cold worker
 *  re-resolves), shared across the bus and the SSE consumer so a pushed update invalidates the same entry the
 *  router populated. */
export const lookupCache = new LookupCache();

/** Resolve a subject to its non-PII status: the DB-first `/contacts/lookup`, then the older slug resolver as a
 *  fallback for an out-of-date server. Throws if BOTH fail so callers degrade to "unknown" without caching a
 *  failure. */
export async function resolveSubjectStatus(
  ctx: RuntimeContext,
  subjectKey: string,
  sourceUrl: string,
): Promise<SubjectStatus> {
  try {
    return await ctx.api.lookupByUrl(sourceUrl);
  } catch {
    return await ctx.api.resolveByLinkedin(subjectKey);
  }
}

/** The bus LOOKUP path: single-flight + warm-cached. */
export function lookupSubject(
  ctx: RuntimeContext,
  subjectKey: string,
  sourceUrl: string,
): Promise<SubjectStatus> {
  return lookupCache.resolve(subjectKey, () => resolveSubjectStatus(ctx, subjectKey, sourceUrl));
}

/** Reconstruct the extension's subjectKey + a lookup URL from a PII-free `contact.lookup_updated` payload. The
 *  server canonicalizes the URL, so a plain reconstruction is enough; the subjectKey mirrors the content-script
 *  adapter (a public slug is the key; a Sales-Nav lead is `sales-lead:<id>`). Null when the payload carries
 *  neither addressing key. */
export function subjectFromLookupEvent(
  payload: Record<string, unknown>,
): { subjectKey: string; sourceUrl: string } | null {
  const slug = payload.linkedinPublicId;
  if (typeof slug === "string" && slug) {
    return { subjectKey: slug, sourceUrl: `https://www.linkedin.com/in/${slug}` };
  }
  const lead = payload.salesNavLeadId;
  if (typeof lead === "string" && lead) {
    return {
      subjectKey: `sales-lead:${lead}`,
      sourceUrl: `https://www.linkedin.com/sales/lead/${lead}`,
    };
  }
  return null;
}

/** The SSE consumer path: a viewed profile changed server-side, so invalidate the stale entry and re-resolve
 *  THROUGH the cache (which repopulates it warm), returning the subjectKey + fresh status to broadcast. Null
 *  when the payload isn't addressable or the resolve fails — the poll safety net covers a missed push. */
export async function refreshSubjectFromEvent(
  ctx: RuntimeContext,
  payload: Record<string, unknown>,
): Promise<{ subjectKey: string; status: SubjectStatus } | null> {
  const target = subjectFromLookupEvent(payload);
  if (!target) return null;
  lookupCache.invalidate(target.subjectKey);
  try {
    const status = await lookupCache.resolve(target.subjectKey, () =>
      resolveSubjectStatus(ctx, target.subjectKey, target.sourceUrl),
    );
    return { subjectKey: target.subjectKey, status };
  } catch {
    return null;
  }
}
