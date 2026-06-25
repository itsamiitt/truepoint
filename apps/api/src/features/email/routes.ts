// routes.ts — HTTP wiring for the M12 email subsystem foundations (email-planning/13 P0; mounted at
// /api/v1/email). Transport only: request schemas come from @leadwolf/types, scope from the VERIFIED token
// (never the body), and every credential/DNS/quota decision lives in packages/core (connectMailbox,
// createSendingDomain, verifySendingDomain) or @leadwolf/db (the repositories). Mailbox/domain reads NEVER
// carry a credential (D7). Connecting a mailbox or managing a sending domain is a workspace owner/admin
// action (the P6 admin surface refines sending-domain management to the tenant-admin org role).

import {
  computeDeliverability,
  connectMailbox,
  createSendingDomain,
  verifySendingDomain,
} from "@leadwolf/core";
import { mailboxRepository, sendQuotaRepository, sendingDomainRepository } from "@leadwolf/db";
import {
  ForbiddenError,
  ValidationError,
  mailboxConnectSchema,
  sendingDomainCreateSchema,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { requireRole } from "../../middleware/requireRole.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";

export const emailRoutes = new Hono<{ Variables: TenancyVariables }>();

emailRoutes.use("*", authn);
emailRoutes.use("*", tenancy);

// ── Mailboxes (workspace-scoped) ────────────────────────────────────────────────────────────────────────
emailRoutes.get("/mailboxes", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace to view mailboxes.");
  const mailboxes = await mailboxRepository.listByWorkspace({
    tenantId: c.get("tenantId"),
    workspaceId,
  });
  return c.json({ mailboxes });
});

// Connect a mailbox — stores the credential KMS-envelope-encrypted server-side (D7). owner/admin only.
emailRoutes.post("/mailboxes", requireRole("owner", "admin"), async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before connecting a mailbox.");
  const parsed = mailboxConnectSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new ValidationError(
      "Body must be { provider, address, sending_domain_id?, smtp_password? | oauth_token? }.",
    );
  const result = await connectMailbox({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    userId: c.get("claims").sub,
    provider: parsed.data.provider,
    address: parsed.data.address,
    sendingDomainId: parsed.data.sending_domain_id ?? null,
    smtpPassword: parsed.data.smtp_password,
    oauthToken: parsed.data.oauth_token,
  });
  return c.json(result, 201);
});

// ── Sending domains (tenant-scoped) ─────────────────────────────────────────────────────────────────────
emailRoutes.get("/sending-domains", async (c) => {
  const domains = await sendingDomainRepository.listByTenant({ tenantId: c.get("tenantId") });
  return c.json({ domains });
});

emailRoutes.post("/sending-domains", requireRole("owner", "admin"), async (c) => {
  const parsed = sendingDomainCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Body must be { domain, region? }.");
  const result = await createSendingDomain({
    scope: { tenantId: c.get("tenantId") },
    userId: c.get("claims").sub,
    domain: parsed.data.domain,
    region: parsed.data.region,
  });
  return c.json(result, 201);
});

// Verify SPF/DKIM/DMARC — promotes the domain to 'verified' only when all pass (the Gmail/Yahoo gate, 03 §1).
emailRoutes.post("/sending-domains/:id/verify", requireRole("owner", "admin"), async (c) => {
  const result = await verifySendingDomain({
    scope: { tenantId: c.get("tenantId") },
    userId: c.get("claims").sub,
    domainId: c.req.param("id"),
  });
  return c.json(result, 200);
});

// ── Send-quota (tenant-scoped, read-only at P0; enforcement wires into the send path at P1) ─────────────
emailRoutes.get("/send-quota", async (c) => {
  const quota = await sendQuotaRepository.snapshot({ tenantId: c.get("tenantId") });
  return c.json(quota);
});

// ── Deliverability + engagement analytics (M12 P5) — workspace-scoped; reply rate is the headline (D6) ──
emailRoutes.get("/analytics", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace to view analytics.");
  const rangeDays = Math.min(365, Math.max(1, Number(c.req.query("days") ?? 30) || 30));
  const report = await computeDeliverability(
    { tenantId: c.get("tenantId"), workspaceId },
    rangeDays,
  );
  return c.json(report);
});
