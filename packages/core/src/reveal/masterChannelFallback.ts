// masterChannelFallback.ts — reveal's Layer-0 channel fallback (Layer-0-as-database plan, slice 6).
// When the workspace copy holds no email/phone but the contact is BRIDGED to a Layer-0 person the platform
// licensed channels for, the reveal serves that value instead of returning null — and copies it onto the
// workspace row so the platform pays the vendor ONCE per value, not once per workspace.
//
// Runs on the ER connection OUTSIDE the charging tenant tx (leadwolf_app has no grant on master_*), exactly
// like the provenance badge read. Gated by MASTER_CHANNEL_REVEAL_ENABLED — the read half of the write gate
// LINKEDIN_CHANNELS_ENABLED. Env is read INSIDE the function so a test can flip it.
import { env } from "@leadwolf/config";
import { type RevealableChannels, masterChannelReadRepository, withErTx } from "@leadwolf/db";
import type { RevealType } from "@leadwolf/types";

export type { RevealableChannels };

const wantsEmail = (t: RevealType): boolean => t === "email" || t === "full_profile";
const wantsPhone = (t: RevealType): boolean => t === "phone" || t === "full_profile";

/** The subset of the reveal's contact row this decision needs. */
export interface FallbackSubject {
  masterPersonId: string | null;
  emailEnc: Uint8Array | null;
  phoneEnc: Uint8Array | null;
}

/**
 * Load licensed Layer-0 channels for the field(s) this reveal wants and the workspace copy lacks.
 * Returns null when the gate is off, the contact is unbridged, or nothing is missing — in every one of
 * those cases the reveal path is byte-identical to before. Never throws: a Layer-0 hiccup must not fail a
 * paid action, it just yields no fallback.
 */
export async function loadMasterChannels(
  contact: FallbackSubject,
  revealType: RevealType,
): Promise<RevealableChannels | null> {
  if (!env.MASTER_CHANNEL_REVEAL_ENABLED || !contact.masterPersonId) return null;
  const want = {
    email: wantsEmail(revealType) && contact.emailEnc == null,
    phone: wantsPhone(revealType) && contact.phoneEnc == null,
  };
  if (!want.email && !want.phone) return null;
  try {
    const found = await withErTx((tx) =>
      masterChannelReadRepository.readRevealableChannels(
        tx,
        contact.masterPersonId as string,
        want,
      ),
    );
    return found.email || found.phone ? found : null;
  } catch (err) {
    console.error("[reveal] master channel fallback failed; serving the overlay copy only", err);
    return null;
  }
}
