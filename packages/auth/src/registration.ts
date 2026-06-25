// registration.ts — the registration core (ADR-0020): turn a proven email + a profile into a global identity
// and place it in an org. Placement is hybrid, first match wins: (1) the email's verified domain is set to
// auto_join → join that org's default workspace; (2) a pending invitation for the email → accept it; (3)
// otherwise → provision a brand-new org (the person becomes its owner). HTTP/transport stays in apps/auth;
// this is pure orchestration over the repositories + the injected domain resolver (same one the identifier
// step uses). The durable session + cross-domain code are issued later, by the normal finalizeLogin path.

import { randomBytes } from "node:crypto";
import {
  invitationRepository,
  tenantMemberRepository,
  tenantRepository,
  userRepository,
  workspaceRepository,
} from "@leadwolf/db";
import { ConflictError, ValidationError } from "@leadwolf/types";
import type { DomainResolver } from "./identifierLookup.ts";
import { hashPassword } from "./password.ts";
import { checkPasswordAcceptable, passwordRejectionMessage } from "./passwordPolicy.ts";

export type Placement = "auto_join" | "invitation" | "new_org";

export interface ProvisionIdentityInput {
  email: string;
  fullName: string;
  username?: string;
  password: string;
  clientIp?: string;
  resolveDomain: DomainResolver;
}

export interface ProvisionedIdentity {
  userId: string;
  tenantId: string;
  workspaceId?: string;
  placement: Placement;
}

// Slug from arbitrary text + a short random suffix — collision-safe without a retry loop (slug is unique).
function slugify(base: string): string {
  const core =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "org";
  return `${core}-${randomBytes(3).toString("hex")}`;
}

export async function provisionIdentity(
  input: ProvisionIdentityInput,
): Promise<ProvisionedIdentity> {
  const email = input.email.trim().toLowerCase();

  // Existence guards. Registration reveals existence by design (ADR-0020), so these are specific, not uniform.
  if (input.username && (await userRepository.usernameExists(input.username))) {
    throw new ConflictError("username_taken");
  }
  if (await userRepository.findByEmail(email)) {
    throw new ConflictError("email_taken"); // race backstop — the identifier step only routes unknown emails here
  }

  // Server-side password policy (NIST SP 800-63B-4): length floor + breached-corpus screen. The /signup edge
  // hints length client-side, but this is the boundary — provisionIdentity is the only path that mints the
  // credential, so a weak/breached password is rejected here regardless of the client.
  const rejection = await checkPasswordAcceptable(input.password);
  if (rejection) throw new ValidationError(passwordRejectionMessage(rejection));

  const passwordHash = await hashPassword(input.password);
  const userId = await userRepository.create({
    email,
    fullName: input.fullName,
    username: input.username,
    passwordHash,
    emailVerifiedAt: new Date(), // /signup proved the email before this runs
  });

  // ── Org placement (first match wins) ──────────────────────────────────────────────────────────────
  const at = email.lastIndexOf("@");
  const domain = at >= 0 ? email.slice(at + 1) : "";
  const routing = domain ? await input.resolveDomain(domain) : null;

  if (routing && routing.joinPolicy === "auto_join") {
    const ws = await workspaceRepository.findDefault(routing.tenantId);
    await tenantMemberRepository.joinOrg({
      tenantId: routing.tenantId,
      userId,
      workspaceId: ws?.id,
      role: "member",
    });
    return { userId, tenantId: routing.tenantId, workspaceId: ws?.id, placement: "auto_join" };
  }

  const invite = await invitationRepository.findPendingByEmail(email);
  if (invite) {
    await tenantMemberRepository.joinOrg({
      tenantId: invite.tenantId,
      userId,
      workspaceId: invite.workspaceId ?? undefined,
      role: invite.role,
      isTenantOwner: invite.isTenantOwner,
      invitedByUserId: undefined,
    });
    await invitationRepository.markAccepted(invite.id);
    return {
      userId,
      tenantId: invite.tenantId,
      workspaceId: invite.workspaceId ?? undefined,
      placement: "invitation",
    };
  }

  // No domain match, no invite → the person founds their own org.
  const { tenantId, workspaceId } = await tenantRepository.provisionNewOrg({
    tenantName: `${input.fullName}'s Organization`,
    tenantSlug: slugify(input.fullName || domain || "org"),
    ownerUserId: userId,
    workspaceName: `${input.fullName}'s Workspace`,
    workspaceSlug: slugify(input.fullName || "workspace"),
  });
  return { userId, tenantId, workspaceId, placement: "new_org" };
}
