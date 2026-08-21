// routes.ts — HTTP wiring for the browser extension's LinkedIn-identity resolver (chrome-extension/14 X01).
// Given the `/in/<publicId>` slug the extension extracts, answer whether THIS workspace already holds that
// contact (masked, non-PII) so the side panel can show status + a reveal/open affordance without re-scraping.
// Transport only: scope comes from the verified token (never the body/path), and masking + RLS live in the db
// layer. A masked read (no spend) → no role gate, matching GET /contacts and GET /:id/revealed (visibility is
// workspace-wide under RLS). The slug alone is never trusted: RLS pins the read to the caller's workspace.
import { checkCaptureRate } from "@leadwolf/auth";
import { env } from "@leadwolf/config";
import {
  LOOKUP_INTEREST_TTL_S,
  blindIndex,
  fetchAndLandUrl,
  linkedinUrlKey,
  lookupInterestKey,
  lookupInterestMember,
} from "@leadwolf/core";
import {
  contactRepository,
  masterPersonReadRepository,
  usageEventRepository,
  withErTx,
  withTenantTx,
} from "@leadwolf/db";
import { ForbiddenError, ValidationError } from "@leadwolf/types";
import { Hono } from "hono";
import { cacheRedis } from "../../cache.ts";
import { authn } from "../../middleware/authn.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";

export const contactsResolveRoutes = new Hono<{ Variables: TenancyVariables }>();

contactsResolveRoutes.use("*", authn);
contactsResolveRoutes.use("*", tenancy);

// GET /by-linkedin/:publicId — resolve the LinkedIn slug to a masked contact in the active workspace. The
// literal `by-linkedin` segment is registered before the reveal router (app.ts) so it is never captured as a
// contact `:id`.
contactsResolveRoutes.get("/by-linkedin/:publicId", async (c) => {
  const claims = c.get("claims");
  const workspaceId = claims.wid;
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace to look up a prospect.");
  // Lowercase = the canonical slug form every write path stores (linkedinPublicIdOf); without this a
  // mixed-case page slug misses a stored lowercase row and the card wrongly offers "Save" on a known contact.
  const publicId = c.req.param("publicId")?.toLowerCase();
  if (!publicId) throw new ValidationError("A LinkedIn public id is required.");

  const contact = await contactRepository.resolveByLinkedinPublicId(
    { tenantId: claims.tid, workspaceId },
    publicId,
  );

  // M1 REVEAL MISS (07 § channel 7, the most-wanted feed; S-12). A lookup that finds nothing is the single
  // highest-value demand signal in the system: it says precisely which records the market wants and we do not
  // have. Distinct from M2/M3 in revealContact, which are "the record exists but this field does not / graded
  // unusable" — those know a contact id; this one has no record to point at.
  //
  // COMPLIANCE (09 rule 3): the fingerprint is a KEYED HMAC of the slug, never the slug itself. A miss log
  // holding raw LinkedIn identifiers would be a shadow database of people we hold nothing about — and an
  // opt-out could not reach it, because there is no record to suppress. Sharing the blind-index key space
  // means a suppression check can still MATCH a fingerprint without this table ever storing the identifier.
  // The obligation this creates is on the READ side: whatever eventually surfaces the most-wanted feed MUST
  // suppression-check before showing an entry. Nothing surfaces it today, so nothing is exposed yet.
  //
  // Non-fatal: this endpoint is the extension's context detect, and a metering failure must never break the
  // side panel. Unlike the reveal path (where the event rides the reveal's own transaction), there is no
  // business transaction here to be atomic with — losing a demand datapoint is a lost metric, not a lost fact.
  if (env.USAGE_EVENTS_ENABLED && contact === null) {
    try {
      // The write is what needs bounding, not the read: the read is already RLS-scoped and free.
      await checkCaptureRate(`resolve-miss:${claims.sub}`, 1);
      await withTenantTx({ tenantId: claims.tid, workspaceId }, (tx) =>
        usageEventRepository.append(tx, {
          tenantId: claims.tid,
          workspaceId,
          userId: claims.sub,
          action: "reveal_miss",
          subjectType: "person",
          subjectFingerprint: blindIndex(`linkedin:${publicId.toLowerCase()}`),
          demandedFields: ["email"],
          metadata: { surface: "extension_resolve" },
        }),
      );
    } catch (err) {
      console.warn("[resolve] miss metering skipped", err);
    }
  }

  return c.json({
    known: contact !== null,
    owned: contact?.isRevealed ?? false,
    contactId: contact?.id ?? null,
    contact,
  });
});

/**
 * POST /lookup — the one-round-trip DB-first / vendor-fallback lookup behind the extension's card
 * (extension-intelligence-loop slice B). Body `{ url }` — any LinkedIn profile form (public slug or
 * Sales-Nav lead/people). Ladder:
 *   1. canonicalize (linkedinUrlKey) — Sales-Nav and public forms of one person collapse;
 *   2. resolve in THIS workspace (slug rung, then sales-nav rung) → `found` + masked contact + freshness;
 *   3. miss → (flag-gated) fetch-and-land from the licensed origin fleet into the master graph, then
 *      report `fetched` — the extension's Save then lands the overlay row whose master bridge LINKs to
 *      what just landed. Landing to the workspace is deliberately NOT automatic: a workspace write stays
 *      behind the user's explicit Save gesture (hard constraint 4).
 * Statuses: found | fetched | not_found | unavailable | not_supported.
 */
contactsResolveRoutes.post("/lookup", async (c) => {
  const claims = c.get("claims");
  const workspaceId = claims.wid;
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace to look up a prospect.");
  const body = (await c.req.json().catch(() => null)) as { url?: unknown } | null;
  if (!body || typeof body.url !== "string") throw new ValidationError("Body must be { url }.");

  const key = linkedinUrlKey(body.url);
  if (!key || key.entityKind !== "person") {
    return c.json({ status: "not_supported", contactId: null, contact: null });
  }

  const isSlugForm = key.normalizedUrl.includes("/in/");
  const slug = isSlugForm ? key.externalId?.toLowerCase() : undefined;
  const salesNavLeadId = isSlugForm ? undefined : (key.externalId ?? undefined);

  const scope = { tenantId: claims.tid, workspaceId };
  const found = await withTenantTx(scope, async (tx) => {
    const match = await contactRepository.findByDedupKeys(tx, workspaceId, {
      linkedinPublicId: slug,
      salesNavLeadId,
    });
    if (!match) return null;
    const [masked] = await contactRepository.listMaskedByIds(tx, [match.id]);
    return masked ?? null;
  });
  if (found) {
    return c.json({
      status: "found",
      contactId: found.id,
      owned: found.isRevealed,
      contact: found,
      lastUpdatedAt: found.lastVerifiedAt ?? found.createdAt,
    });
  }

  // MISS ONLY (perf-checklist PA-11): register this workspace's interest so the background 30-day sweep can
  // push contact.lookup_updated when it next (re)lands this URL (chrome-extension/15 §13, option D). This
  // used to run at the TOP of the handler — but the extension's steady state is "already in this workspace",
  // which returns above, and only a MISS can ever be landed by the sweep: the hit path was paying one Redis
  // round-trip per lookup to write sets that were structurally guaranteed to expire unused. Best-effort and
  // TTL-bounded: a Redis blip or an expired interest just means no push, and the extension's next LOOKUP
  // re-reads the truth. multi() so the set never lingers without a TTL. Gated on REALTIME_SSE_ENABLED
  // because nothing consumes the set otherwise.
  if (env.REALTIME_SSE_ENABLED) {
    try {
      const interestKey = lookupInterestKey(key.normalizedUrl);
      await cacheRedis()
        .multi()
        .sadd(interestKey, lookupInterestMember(claims.tid, workspaceId))
        .expire(interestKey, LOOKUP_INTEREST_TTL_S)
        .exec();
    } catch {
      // best-effort — the live push is a nice-to-have layered on the poll safety net
    }
  }

  // Not in the workspace — is the person already in the platform DATABASE? (Layer-0-as-database slice 4:
  // the database is the product; an instant hit needs no vendor call at all.)
  const readDatabasePerson = () =>
    withErTx(async (tx) => {
      if (slug) return masterPersonReadRepository.readVisiblePerson(tx, { slug });
      const personId = await masterPersonReadRepository.resolveRegistryPerson(
        tx,
        key.normalizedUrl,
      );
      return personId ? masterPersonReadRepository.readVisiblePerson(tx, { id: personId }) : null;
    });
  const toPerson = (row: NonNullable<Awaited<ReturnType<typeof readDatabasePerson>>>) => ({
    linkedinPublicId: row.linkedinPublicId,
    linkedinUrl: `https://www.linkedin.com/in/${row.linkedinPublicId}`,
    fullName: row.fullName,
    jobTitle: row.jobTitle ?? row.headline,
    headline: row.headline,
    seniorityLevel: row.seniorityLevel,
    companyName: row.company?.name ?? null,
    locationRaw: row.locationRaw,
    locationCity: row.locationCity,
    locationCountry: row.locationCountry,
    hasEmail: row.hasEmail,
    hasPhone: row.hasPhone,
  });
  const inDb = await readDatabasePerson();
  if (inDb) {
    return c.json({
      status: "in_database",
      contactId: null,
      contact: null,
      person: toPerson(inDb),
    });
  }

  // Not in the database either — pull the licensed document into the master graph (bounded; the 30-day
  // freshness clock inside fetchAndLandUrl means a repeat view costs no vendor call), then RE-READ so the
  // caller gets the identity, not a boolean. Flag-off degrades to an honest not_found.
  if (!env.LINKEDIN_LINK_FETCH_ENABLED) {
    return c.json({ status: "not_found", contactId: null, contact: null });
  }
  await checkCaptureRate(`link-fetch:${claims.sub}`, 1);
  const result = await fetchAndLandUrl({
    entityKind: "person",
    normalizedUrl: key.normalizedUrl,
  });
  if (result.outcome === "landed" || result.outcome === "fresh" || result.outcome === "duplicate") {
    const landed = await readDatabasePerson();
    if (landed) {
      return c.json({
        status: "in_database",
        contactId: null,
        contact: null,
        person: toPerson(landed),
      });
    }
    return c.json({ status: "not_found", contactId: null, contact: null });
  }
  const status = result.outcome === "unavailable" ? "unavailable" : "not_found";
  return c.json({ status, contactId: null, contact: null });
});
