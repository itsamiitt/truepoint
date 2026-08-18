// masterChannelReadRepository.ts — the ONE read of Layer-0 channel VALUES (Layer-0-as-database plan,
// slice 6 [S-04][S-08]). Until now master_emails/master_phones were write-only: the licensed landing
// encrypted values into them and nothing ever decrypted them, so two workspaces each paid the vendor for
// the same email. This read is what makes the database a database.
//
// Three guards are inside the query, not the caller:
//   • the person must be VISIBLE (licensed/co-op, unsuppressed, unmerged) — a suppressed subject's value is
//     unreadable even though the row may still exist;
//   • the channel must carry a value AND have been contributed by a LICENSED provider (source_name), so a
//     co-op/import-contributed row is never served across workspaces;
//   • one row wins deterministically: primary, then work, then verified-valid, then best-corroborated.
// Runs under withErTx; the caller decides whether the reveal gate is on.
import { sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { MASTER_PERSON_VISIBLE } from "./masterPersonReadRepository.ts";

/** Only a licensed provider's contribution may be revealed across workspaces (0121 D3). */
const LICENSED_SOURCE = "linkedin_api";

export interface MasterEmailChannel {
  enc: Uint8Array;
  blindIndex: Uint8Array;
  domain: string | null;
  status: string;
  type: string | null;
}

export interface MasterPhoneChannel {
  enc: Uint8Array;
  blindIndex: Uint8Array;
  lineType: string | null;
  status: string | null;
}

export interface RevealableChannels {
  email?: MasterEmailChannel;
  phone?: MasterPhoneChannel;
}

/** postgres.js returns bytea as Buffer; normalize so callers always see a Uint8Array. */
function bytes(v: unknown): Uint8Array {
  return v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBufferLike);
}

export const masterChannelReadRepository = {
  async readRevealableChannels(
    tx: Tx,
    masterPersonId: string,
    want: { email: boolean; phone: boolean },
  ): Promise<RevealableChannels> {
    const out: RevealableChannels = {};
    if (want.email) {
      const rows = (await tx.execute(sql`
        SELECT e.email_enc, e.email_blind_index, e.email_domain, e.email_status, e.email_type
          FROM master_emails e
          JOIN master_persons p ON p.id = e.master_person_id
         WHERE p.id = ${masterPersonId}::uuid AND ${MASTER_PERSON_VISIBLE("p")}
           AND e.email_enc IS NOT NULL AND e.source_name = ${LICENSED_SOURCE}
         ORDER BY e.is_primary DESC, (e.email_type = 'work') DESC,
                  (e.email_status = 'valid') DESC, e.source_count DESC, e.created_at
         LIMIT 1
      `)) as unknown as Array<{
        email_enc: unknown;
        email_blind_index: unknown;
        email_domain: string | null;
        email_status: string;
        email_type: string | null;
      }>;
      const r = rows[0];
      if (r) {
        out.email = {
          enc: bytes(r.email_enc),
          blindIndex: bytes(r.email_blind_index),
          domain: r.email_domain,
          status: r.email_status,
          type: r.email_type,
        };
      }
    }
    if (want.phone) {
      const rows = (await tx.execute(sql`
        SELECT ph.phone_enc, ph.phone_blind_index, ph.line_type, ph.phone_status
          FROM master_phones ph
          JOIN master_persons p ON p.id = ph.master_person_id
         WHERE p.id = ${masterPersonId}::uuid AND ${MASTER_PERSON_VISIBLE("p")}
           AND ph.phone_enc IS NOT NULL AND ph.source_name = ${LICENSED_SOURCE}
         ORDER BY (ph.line_type = 'mobile') DESC, ph.source_count DESC, ph.created_at
         LIMIT 1
      `)) as unknown as Array<{
        phone_enc: unknown;
        phone_blind_index: unknown;
        line_type: string | null;
        phone_status: string | null;
      }>;
      const r = rows[0];
      if (r) {
        out.phone = {
          enc: bytes(r.phone_enc),
          blindIndex: bytes(r.phone_blind_index),
          lineType: r.line_type,
          status: r.phone_status,
        };
      }
    }
    return out;
  },
};
