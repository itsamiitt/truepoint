// routes.ts — HTTP wiring for Sales Navigator link capture (05 §5, M7): POST/GET/DELETE
// /sales-navigator/links. HITL by design (ADR-0009): a human pastes the link — assisted capture only, the
// api never automates against LinkedIn/Sales Nav. Dedup + parse + insert live in core; this is transport only.

import { captureSalesNavLink } from "@leadwolf/core";
import { salesNavLinkRepository } from "@leadwolf/db";
import {
  ForbiddenError,
  NotFoundError,
  type SalesNavCaptureResult,
  type SalesNavLinkDTO,
  ValidationError,
  salesNavLinkSchema,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";

export const salesNavRoutes = new Hono<{ Variables: TenancyVariables }>();

salesNavRoutes.use("*", authn);
salesNavRoutes.use("*", tenancy);

salesNavRoutes.post("/links", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before capturing links.");
  const parsed = salesNavLinkSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new ValidationError(
      "Body must be { link_type, url, external_id?, contact_id?, note?, labels? }.",
    );
  const result = await captureSalesNavLink({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    linkType: parsed.data.link_type,
    url: parsed.data.url,
    externalId: parsed.data.external_id,
    contactId: parsed.data.contact_id,
    note: parsed.data.note,
    labels: parsed.data.labels,
    capturedByUserId: c.get("claims").sub,
  });
  // 200 on a dedup hit (nothing created), 201 on a fresh capture — the body carries `deduped` either way.
  const body: SalesNavCaptureResult = result;
  return c.json(body, result.deduped ? 200 : 201);
});

salesNavRoutes.get("/links", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace to list captured links.");
  const rows = await salesNavLinkRepository.listByWorkspace({
    tenantId: c.get("tenantId"),
    workspaceId,
  });
  const links: SalesNavLinkDTO[] = rows.map((r) => ({
    id: r.id,
    linkType: r.linkType as SalesNavLinkDTO["linkType"],
    url: r.url,
    externalId: r.externalId,
    note: r.note,
    labels: r.labels,
    contactId: r.contactId,
    accountId: r.accountId,
    capturedAt: r.capturedAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
  }));
  return c.json({ links });
});

salesNavRoutes.delete("/links/:id", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace to remove a captured link.");
  const removed = await salesNavLinkRepository.deleteById(
    { tenantId: c.get("tenantId"), workspaceId },
    c.req.param("id"),
  );
  if (!removed) throw new NotFoundError("Captured link not found in this workspace.");
  return c.body(null, 204);
});
