// jit.ts — Just-In-Time provisioning from a verified SSO assertion (17 §7, ADR-0020). Maps the asserted
// email to a global identity (creating it on first SSO login when the tenant allows JIT), then ensures the
// person is a member of the SSO tenant + its default workspace at the configured default role. Idempotent:
// returning SSO users simply re-resolve to their existing identity and membership.

import { tenantMemberRepository, userRepository, workspaceRepository } from "@leadwolf/db";
import { ForbiddenError } from "@leadwolf/types";
import type { SsoAssertion, SsoConfig } from "./types.ts";

export async function provisionSsoIdentity(input: {
  assertion: SsoAssertion;
  config: SsoConfig;
}): Promise<{ userId: string; workspaceId?: string }> {
  const email = input.assertion.email.trim().toLowerCase();

  let userId = (await userRepository.findByEmail(email))?.id;
  if (!userId) {
    if (!input.config.jitEnabled) {
      throw new ForbiddenError("sso_jit_disabled", "Your account has not been provisioned for SSO.");
    }
    userId = await userRepository.create({
      email,
      fullName: input.assertion.fullName ?? email,
      authProvider: "sso",
      emailVerifiedAt: new Date(), // the IdP vouches for the address
    });
  }

  const ws = await workspaceRepository.findDefault(input.config.tenantId);
  await tenantMemberRepository.joinOrg({
    tenantId: input.config.tenantId,
    userId,
    workspaceId: ws?.id,
    role: input.config.defaultRole,
  });
  return { userId, workspaceId: ws?.id };
}
