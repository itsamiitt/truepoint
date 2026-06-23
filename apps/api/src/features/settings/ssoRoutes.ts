// ssoRoutes.ts — HTTP wiring for the tenant SSO (SAML/OIDC) configuration (17 §7, ADR-0017/0018):
//   GET /api/v1/settings/security/sso → the MASKED config (hasClientSecret only; never the secret)
//   PUT /api/v1/settings/security/sso → upsert the config → the re-read masked view
// TENANT-scoped (not a workspace setting) and gated to security_admin or owner. Mounted by the lead under
// /security/sso on the parent settingsRoutes (which already applies authn + tenancy). Transport only: validate
// the body, encrypt the client secret server-side, then read/write through the repository (RLS tenant-scoped).
// The OIDC client secret is write-only — it is encrypted here (encryptSecret) and NEVER returned to the client.

import { encryptSecret } from "@leadwolf/auth";
import { ssoConfigRepository } from "@leadwolf/db";
import { ValidationError, ssoConfigUpdateSchema } from "@leadwolf/types";
import { Hono } from "hono";
import type { ApiVariables } from "../../middleware/authn.ts";
import { requireOrgRole } from "../../middleware/requireOrgRole.ts";

export const ssoRoutes = new Hono<{ Variables: ApiVariables }>();

ssoRoutes.get("/", requireOrgRole("security_admin", "owner"), async (c) => {
  const config = await ssoConfigRepository.getForTenant(c.get("claims").tid);
  return c.json(config, 200);
});

ssoRoutes.put("/", requireOrgRole("security_admin", "owner"), async (c) => {
  const tenantId = c.get("claims").tid;
  const parsed = ssoConfigUpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new ValidationError("Invalid SSO configuration.", { issues: parsed.error.issues });

  // Split the write-only client secret out of the validated body: encrypt it server-side (the bytes never
  // leave the server), and pass the rest of the fields through unchanged. An absent secret leaves the stored
  // one untouched (oidcClientSecretEnc stays undefined → the repository skips that column on update).
  const { oidcClientSecret, ...fields } = parsed.data;
  const oidcClientSecretEnc =
    oidcClientSecret !== undefined ? await encryptSecret(oidcClientSecret) : undefined;

  await ssoConfigRepository.upsert(
    tenantId,
    { ...fields, oidcClientSecretEnc },
    c.get("claims").sub,
  );

  // Re-read the masked view so the client gets the persisted state (with hasClientSecret), never the secret.
  const config = await ssoConfigRepository.getForTenant(tenantId);
  return c.json(config, 200);
});
