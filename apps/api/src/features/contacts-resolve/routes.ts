// routes.ts — HTTP wiring for the browser extension's LinkedIn-identity resolver (chrome-extension/14 X01).
// Given the `/in/<publicId>` slug the extension extracts, answer whether THIS workspace already holds that
// contact (masked, non-PII) so the side panel can show status + a reveal/open affordance without re-scraping.
// Transport only: scope comes from the verified token (never the body/path), and masking + RLS live in the db
// layer. A masked read (no spend) → no role gate, matching GET /contacts and GET /:id/revealed (visibility is
// workspace-wide under RLS). The slug alone is never trusted: RLS pins the read to the caller's workspace.
import { checkCaptureRate } from "@leadwolf/auth";
import { env } from "@leadwolf/config";
import { blindIndex } from "@leadwolf/core";
import { contactRepository, usageEventRepository, withTenantTx } from "@leadwolf/db";
import { ForbiddenError, ValidationError } from "@leadwolf/types";
import { Hono } from "hono";
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
  const publicId = c.req.param("publicId");
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
