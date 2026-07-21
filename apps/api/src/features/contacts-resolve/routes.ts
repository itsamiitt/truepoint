// routes.ts — HTTP wiring for the browser extension's LinkedIn-identity resolver (chrome-extension/14 X01).
// Given the `/in/<publicId>` slug the extension extracts, answer whether THIS workspace already holds that
// contact (masked, non-PII) so the side panel can show status + a reveal/open affordance without re-scraping.
// Transport only: scope comes from the verified token (never the body/path), and masking + RLS live in the db
// layer. A masked read (no spend) → no role gate, matching GET /contacts and GET /:id/revealed (visibility is
// workspace-wide under RLS). The slug alone is never trusted: RLS pins the read to the caller's workspace.
import { contactRepository } from "@leadwolf/db";
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
  return c.json({
    known: contact !== null,
    owned: contact?.isRevealed ?? false,
    contactId: contact?.id ?? null,
    contact,
  });
});
