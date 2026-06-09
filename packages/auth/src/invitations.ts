// invitations.ts — the invitation core (ADR-0020). createInvitation mints a pending invite + a single-use
// link token (only its hash is stored); acceptInvitationToken validates that token against the accepting
// identity and joins them to the org. Brand-new invitees are already auto-accepted by email at /signup
// (registration.ts); this token path covers an EXISTING identity accepting an invite link, and is the
// primitive the Settings "invite teammates" send flow calls. Transport/HTTP stays in the apps.

import { createHash, randomBytes } from "node:crypto";
import { invitationRepository, tenantMemberRepository } from "@leadwolf/db";

const DEFAULT_TTL_HOURS = 168; // 7 days
const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export interface CreateInvitationInput {
  tenantId: string;
  workspaceId?: string;
  email: string;
  role?: string;
  isTenantOwner?: boolean;
  invitedByUserId?: string;
  ttlHours?: number;
}

/** Create a pending invite and return the raw link token (handed to the mailer; never persisted in clear). */
export async function createInvitation(
  input: CreateInvitationInput,
): Promise<{ id: string; token: string }> {
  const token = randomBytes(32).toString("base64url");
  const { id } = await invitationRepository.create({
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    email: input.email.trim().toLowerCase(),
    role: input.role,
    isTenantOwner: input.isTenantOwner,
    tokenHash: hashToken(token),
    invitedByUserId: input.invitedByUserId,
    expiresAt: new Date(Date.now() + (input.ttlHours ?? DEFAULT_TTL_HOURS) * 3_600_000),
  });
  return { id, token };
}

export type AcceptInvitationResult =
  | { ok: true; tenantId: string; workspaceId: string | null }
  | { ok: false; reason: "invalid" | "expired" | "accepted" | "email_mismatch" };

/** Validate a link token for the accepting identity and join them to the org. Idempotent join (ADR-0020). */
export async function acceptInvitationToken(input: {
  token: string;
  userId: string;
  userEmail: string;
}): Promise<AcceptInvitationResult> {
  const inv = await invitationRepository.findByTokenHash(hashToken(input.token.trim()));
  if (!inv) return { ok: false, reason: "invalid" };
  if (inv.acceptedAt) return { ok: false, reason: "accepted" };
  if (inv.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired" };
  // The invite is bound to a specific address — the signed-in identity must own it.
  if (inv.email.toLowerCase() !== input.userEmail.trim().toLowerCase()) {
    return { ok: false, reason: "email_mismatch" };
  }

  await tenantMemberRepository.joinOrg({
    tenantId: inv.tenantId,
    userId: input.userId,
    workspaceId: inv.workspaceId ?? undefined,
    role: inv.role,
    isTenantOwner: inv.isTenantOwner,
    invitedByUserId: undefined,
  });
  await invitationRepository.markAccepted(inv.id);
  return { ok: true, tenantId: inv.tenantId, workspaceId: inv.workspaceId };
}
