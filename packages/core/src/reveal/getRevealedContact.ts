// getRevealedContact.ts — the NO-CHARGE "view already-revealed data" reads (Phase 1 single + Phase 2 batch).
// This is what lets an already-revealed contact show its email/phone instantly and persistently, without
// re-running (and re-charging) the reveal. It decrypts email/phone ONLY for the reveal_types this workspace
// already owns (a contact_reveals claim), so it can never surface PII the workspace hasn't paid for. RLS
// scopes every read to the workspace; the decrypt happens IN core (the ciphertext never leaves the server).
// No credit is spent.

import {
  type LiveEmailChannelRow,
  type LivePhoneChannelRow,
  type TenantScope,
  contactChannelRepository,
  contactRepository,
  revealRepository,
  withTenantTx,
} from "@leadwolf/db";
import type {
  RevealDataSource,
  RevealType,
  RevealedContact,
  RevealedEmailValue,
  RevealedPhoneValue,
} from "@leadwolf/types";
import { isChannelReadFromChildEnabled } from "../channels/channelRead.ts";
import { decryptPii } from "../import/encryptPii.ts";

type Claim = {
  revealType: string;
  dataSource: string;
  creditsConsumed: number;
  revealedAt: Date;
  revealedByUserId: string;
};

type RevealView = {
  emailEnc: Uint8Array | null;
  phoneEnc: Uint8Array | null;
  emailStatus: string;
  phoneStatus: string | null;
  phoneLineType: string | null;
  linkedinUrl: string | null;
};

/** All live child rows for one contact (S-CH4 gate-on) — passed in so buildRevealedContact stays the single
 *  ownership boundary that decrypts them. Undefined gate-off ⇒ the additive value arrays are absent. */
interface LiveChannelValues {
  emails?: LiveEmailChannelRow[];
  phones?: LivePhoneChannelRow[];
}

/** Assemble the RevealedContact from a contact's claims + ciphertext view, decrypting ONLY owned fields. */
function buildRevealedContact(
  contactId: string,
  claims: Claim[],
  view: RevealView,
  live?: LiveChannelValues,
): RevealedContact {
  const ownedEmail = claims.some(
    (c) => c.revealType === "email" || c.revealType === "full_profile",
  );
  const ownedPhone = claims.some(
    (c) => c.revealType === "phone" || c.revealType === "full_profile",
  );

  // Decrypt ONLY owned fields — the ownership check is the security boundary.
  const email = ownedEmail && view.emailEnc ? decryptPii(view.emailEnc) : null;
  const phone = ownedPhone && view.phoneEnc ? decryptPii(view.phoneEnc) : null;

  // S-CH4 (05 §5): an owned email/phone claim unmasks ALL live values of that channel, primary-first (the
  // repo's ordering). ADDITIVE + gate-on only — `live` is undefined gate-off ⇒ `emails`/`phones` are absent
  // and the payload is byte-identical; the scalar `email`/`phone` above keep meaning THE PRIMARY (CH-INV-1).
  const emails: RevealedEmailValue[] | undefined =
    ownedEmail && live?.emails
      ? live.emails.map((r) => ({
          value: decryptPii(r.valueEnc),
          type: r.type,
          status: r.status,
          isPrimary: r.isPrimary,
        }))
      : undefined;
  const phones: RevealedPhoneValue[] | undefined =
    ownedPhone && live?.phones
      ? live.phones.map((r) => ({
          value: decryptPii(r.valueEnc),
          type: r.type,
          status: r.status,
          lineType: r.lineType,
          extension: r.extension,
          isPrimary: r.isPrimary,
        }))
      : undefined;

  const revealedFields: string[] = [];
  if (email) revealedFields.push("email");
  if (phone) revealedFields.push("phone");

  const ownedTypes = Array.from(new Set(claims.map((c) => c.revealType))) as RevealType[];

  return {
    contactId,
    email,
    phone,
    ...(emails ? { emails } : {}),
    ...(phones ? { phones } : {}),
    // linkedinUrl is a clear-text public URL (not encrypted / charged), but the masked list only ever exposed
    // a `hasLinkedin` boolean — so gate the URL behind the EMAIL (identity) reveal, not any claim: a phone-only
    // reveal must not hand back the LinkedIn URL for free.
    linkedinUrl: ownedEmail ? view.linkedinUrl : null,
    emailStatus: ownedEmail ? view.emailStatus : null,
    phoneStatus: ownedPhone ? view.phoneStatus : null,
    phoneLineType: ownedPhone ? view.phoneLineType : null,
    ownedTypes,
    revealedFields,
    history: claims.map((c) => ({
      revealType: c.revealType as RevealType,
      dataSource: c.dataSource as RevealDataSource,
      creditsConsumed: c.creditsConsumed,
      revealedAt: c.revealedAt.toISOString(),
      revealedByUserId: c.revealedByUserId,
    })),
  };
}

/** Single contact — the record-detail drawer. Returns null when the contact is gone in this workspace. */
export async function getRevealedContact(
  scope: TenantScope & { workspaceId: string },
  contactId: string,
): Promise<RevealedContact | null> {
  return withTenantTx(scope, async (tx) => {
    const claims = await revealRepository.listContactClaims(tx, scope.workspaceId, contactId);
    const view = await revealRepository.getRevealView(tx, contactId);
    if (!view) return null; // contact gone (tombstoned / never existed in this workspace)
    // S-CH4 composed read gate, evaluated in the SAME tx (shares its fate; env off ⇒ zero queries). Gate-on
    // the reveal read gains ALL live email/phone values primary-first (from the child); gate-off byte-identical.
    let live: LiveChannelValues | undefined;
    if (await isChannelReadFromChildEnabled(tx, scope.tenantId)) {
      const emails = await contactChannelRepository.listLiveEmailValuesByContactIds(tx, [contactId]);
      const phones = await contactChannelRepository.listLivePhoneValuesByContactIds(tx, [contactId]);
      live = { emails: emails.get(contactId) ?? [], phones: phones.get(contactId) ?? [] };
    }
    return buildRevealedContact(contactId, claims, view, live);
  });
}

/**
 * Batch — hydrate the already-owned reveal data for a page of contact ids (the grid's visible rows). Only
 * returns rows the workspace owns SOMETHING for (nothing to hydrate otherwise). `visibleContactIds` is the
 * cross-workspace guard (drops ids not RLS-visible / not live); the per-id decrypt is still gated on ownership.
 */
export async function getRevealedContactsBatch(
  scope: TenantScope & { workspaceId: string },
  contactIds: string[],
): Promise<RevealedContact[]> {
  if (contactIds.length === 0) return [];
  return withTenantTx(scope, async (tx) => {
    const visible = await contactRepository.visibleContactIds(tx, contactIds);
    if (visible.length === 0) return [];

    // Sequential (same tx = one connection); grouped in memory to avoid N per-row round-trips.
    const claims = await revealRepository.listClaimsByContactIds(tx, scope.workspaceId, visible);
    const views = await revealRepository.getRevealViewByIds(tx, visible);

    const claimsByContact = new Map<string, Claim[]>();
    for (const c of claims) {
      const list = claimsByContact.get(c.contactId);
      if (list) list.push(c);
      else claimsByContact.set(c.contactId, [c]);
    }
    const viewById = new Map(views.map((v) => [v.id, v]));

    // S-CH4 gate (05 §5), evaluated ONCE in this tx: gate-on, batch-load ALL live channel values for the
    // visible page (ONE query per table, no N+1); gate-off ⇒ zero child reads, byte-identical output.
    let liveEmailsById: Map<string, LiveEmailChannelRow[]> | undefined;
    let livePhonesById: Map<string, LivePhoneChannelRow[]> | undefined;
    if (await isChannelReadFromChildEnabled(tx, scope.tenantId)) {
      liveEmailsById = await contactChannelRepository.listLiveEmailValuesByContactIds(tx, visible);
      livePhonesById = await contactChannelRepository.listLivePhoneValuesByContactIds(tx, visible);
    }

    const out: RevealedContact[] = [];
    for (const id of visible) {
      const view = viewById.get(id);
      const cs = claimsByContact.get(id);
      // Only hydrate rows that actually own a reveal (skip masked rows — nothing to show).
      if (!view || !cs || cs.length === 0) continue;
      const live: LiveChannelValues | undefined = liveEmailsById
        ? { emails: liveEmailsById.get(id) ?? [], phones: livePhonesById?.get(id) ?? [] }
        : undefined;
      out.push(buildRevealedContact(id, cs, view, live));
    }
    return out;
  });
}
