// intel.ts — resolution for the Profile Intelligence Panel's ONE read, with the same coalescing discipline
// the LOOKUP path already has (cache.ts) and for the same reason: the panel re-asks on every navigation, tab
// switch and re-mount, and each of those can arrive in a burst.
//
// Why a SECOND cache instance rather than sharing `lookupCache`: the two hold different shapes for the same
// key and have different lifetimes — a hover-card status is cheap and should stay warm briefly, while the
// intel payload is large and worth holding a little longer. They are invalidated at exactly the same points,
// which is the property that matters, and that is enforced in the bus router where every mutation lives.
//
// WHAT RIDES ALONG. The panel needs the reveal PRICES (to label its buttons without hardcoding a number) and,
// for a contact this workspace already owns, the values it already paid for. The costs come from the SW's
// CreditsStore; the owned values come from the NO-CHARGE `/contacts/:id/revealed` read (ADR-0042) — never
// from a second reveal. Both are folded in here so the panel renders in one pass rather than three.
import type { IntelPayload } from "../../shared/messages.ts";
import type { RuntimeContext } from "../context.ts";
import { LookupCache } from "./cache.ts";

/** Longer than the LOOKUP warm window (60s): this payload is larger, changes far less often, and is fetched
 *  when a human opens a panel rather than on every DOM settle. Still memory-only — it dies with the worker. */
const INTEL_TTL_MS = 5 * 60_000;

/** The single warm cache for panel intel. Invalidated wherever `lookupCache` is (see the bus router). */
export const intelCache = new LookupCache<IntelPayload>(INTEL_TTL_MS);

/**
 * Resolve everything the panel renders for one subject.
 *
 * `force` is the panel's re-capture control: it drops the warm entry AND asks the server to refresh the
 * licensed document first (`viewFetch` — the same fetch-on-view the content script fires, honouring the same
 * 30-day freshness clock, so a repeat click costs no vendor call). The refresh is best-effort: if the source
 * fleet is dark or down we still return what the database holds, which is the honest answer.
 *
 * A failure propagates rather than resolving to an empty payload — the bus turns it into a typed error the
 * panel renders as an in-surface retry, and nothing is cached, so a blip cannot stick for the window.
 */
export async function resolveIntel(
  ctx: RuntimeContext,
  subjectKey: string,
  sourceUrl: string,
  opts: { force?: boolean; entityKind?: "person" | "company" } = {},
): Promise<IntelPayload> {
  if (opts.force) {
    intelCache.invalidate(subjectKey);
    try {
      await ctx.api.viewFetch(opts.entityKind ?? "person", sourceUrl);
    } catch {
      // Best-effort: a dark/unavailable source fleet must not block rendering what we already hold.
    }
  }

  return intelCache.resolve(subjectKey, async () => {
    const intel = await ctx.api.lookupIntel(sourceUrl);
    // The balance refresh is fire-and-forget-ish: it populates the pill and the costs the buttons label
    // themselves with. It must never fail the read — a panel that renders without a price is fine; a panel
    // that renders nothing because the balance call failed is not.
    const [revealed] = await Promise.all([
      intel.owned && intel.contactId ? ctx.api.revealedContact(intel.contactId) : null,
      ctx.credits.refresh().catch(() => undefined),
    ]);
    return { intel, costs: ctx.credits.costs, revealed, fetchedAt: Date.now() };
  });
}
