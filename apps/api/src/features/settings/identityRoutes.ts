// identityRoutes.ts — HTTP wiring for the Tenant ▸ Security ▸ Domains & SCIM surface (enterprise IAM, 17 /
// ADR-0017/0018). Mounted at /api/v1/settings/security/identity (the parent settingsRoutes already applies
// authn + tenancy). TENANT-scoped and gated to security_admin|owner on EVERY route. Transport only: validate
// the body with Zod, then read/write through the repositories (RLS tenant-scoped, audited in-tx).
//
//   GET    /domains             → list claimed domains
//   POST   /domains             → claim a domain { domain }
//   POST   /domains/:id/verify  → mark a domain verified (DNS TXT check is WIRE-deferred)
//   GET    /scim/tokens         → list SCIM tokens (MASKED — never the token or its hash)
//   POST   /scim/tokens         → mint a SCIM token { name } → returns { id, name, token } ONCE
//   DELETE /scim/tokens/:id     → revoke a SCIM token
//
// SECURITY: the SCIM token plaintext is generated + SHA-256-hashed HERE and returned exactly once; only the
// hash is persisted (the repo never sees the plaintext). The list never returns the value or the hash.
//
// The SCIM 2.0 provisioning PROTOCOL endpoints (/scim/v2/Users) that an IdP calls with these bearer tokens are
// a SEPARATE service surface — they live in apps/api/src/features/scim (mounted at /scim/v2, with their own
// scimAuth bearer middleware). This file manages the TOKENS only (mint/list/revoke). (/scim/v2/Groups: TODO.)

import { createHash, randomBytes } from "node:crypto";
import { domainRepository, scimTokenRepository } from "@leadwolf/db";
import {
  type DomainView,
  NotFoundError,
  type ScimTokenView,
  ValidationError,
  createScimTokenSchema,
  domainClaimSchema,
} from "@leadwolf/types";
import { Hono } from "hono";
import { requireOrgRole } from "../../middleware/requireOrgRole.ts";
import type { TenancyVariables } from "../../middleware/tenancy.ts";

export const identityRoutes = new Hono<{ Variables: TenancyVariables }>();

// Every route on this surface is security_admin|owner (owner implies all). Belt-and-braces over the parent
// settingsRoutes middleware; this sub-router is never reachable without an active, sufficiently-privileged
// membership.
identityRoutes.use("*", requireOrgRole("security_admin", "owner"));

// ── Domains ──────────────────────────────────────────────────────────────────────────────────────────────

function toDomainView(d: {
  id: string;
  domain: string;
  status: string;
  joinPolicy: string;
  verifiedAt: Date | null;
}): DomainView {
  return {
    id: d.id,
    domain: d.domain,
    status: d.status as DomainView["status"],
    joinPolicy: d.joinPolicy as DomainView["joinPolicy"],
    verifiedAt: d.verifiedAt ? d.verifiedAt.toISOString() : null,
  };
}

identityRoutes.get("/domains", async (c) => {
  const domains = await domainRepository.listForTenant(c.get("tenantId"));
  return c.json({ domains: domains.map(toDomainView) }, 200);
});

identityRoutes.post("/domains", async (c) => {
  const parsed = domainClaimSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new ValidationError("Invalid domain.", { issues: parsed.error.issues });
  const row = await domainRepository.claim(
    c.get("tenantId"),
    parsed.data.domain,
    c.get("claims").sub,
  );
  return c.json(toDomainView(row), 201);
});

identityRoutes.post("/domains/:id/verify", async (c) => {
  const id = c.req.param("id");
  // WIRE: the DNS TXT check (resolve dns_txt_record, compare verification_token) runs before this flip.
  const row = await domainRepository.markVerified(c.get("tenantId"), id, c.get("claims").sub);
  if (!row) throw new NotFoundError("That domain does not exist.");
  return c.json(toDomainView(row), 200);
});

// ── SCIM tokens ──────────────────────────────────────────────────────────────────────────────────────────

function toScimView(t: {
  id: string;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}): ScimTokenView {
  return {
    id: t.id,
    name: t.name,
    createdAt: t.createdAt.toISOString(),
    lastUsedAt: t.lastUsedAt ? t.lastUsedAt.toISOString() : null,
    revokedAt: t.revokedAt ? t.revokedAt.toISOString() : null,
  };
}

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

identityRoutes.get("/scim/tokens", async (c) => {
  const tokens = await scimTokenRepository.listForTenant(c.get("tenantId"));
  return c.json({ tokens: tokens.map(toScimView) }, 200);
});

identityRoutes.post("/scim/tokens", async (c) => {
  const parsed = createScimTokenSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new ValidationError("Invalid SCIM token.", { issues: parsed.error.issues });

  // Generate the plaintext ONCE: a `scim_` prefix + 32 random bytes (hex). Hash it (SHA-256) for storage;
  // the plaintext is returned to the caller exactly once below and is never persisted or recoverable.
  const token = `scim_${randomBytes(32).toString("hex")}`;
  const tokenHash = sha256Hex(token);

  const { id } = await scimTokenRepository.create(
    c.get("tenantId"),
    parsed.data.name,
    tokenHash,
    c.get("claims").sub,
  );
  // The ONLY response that carries the plaintext token.
  return c.json({ id, name: parsed.data.name, token }, 201);
});

identityRoutes.delete("/scim/tokens/:id", async (c) => {
  const id = c.req.param("id");
  const revoked = await scimTokenRepository.revoke(c.get("tenantId"), id, c.get("claims").sub);
  if (!revoked) throw new NotFoundError("That SCIM token does not exist.");
  return c.body(null, 204);
});
