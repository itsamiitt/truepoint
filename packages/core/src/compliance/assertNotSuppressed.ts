// assertNotSuppressed.ts — the unbypassable suppression/DNC gate (08 §3, H5): runs INSIDE the reveal
// transaction (and the send transaction at M9) so no code path can reveal or message a suppressed
// contact. Throws SuppressedError; the caller's transaction rolls back, so nothing is charged. The
// blocked-attempt audit is written by the caller OUTSIDE the rolled-back tx (it must survive the
// rollback — M3 DoD: "suppressed → 403 + reveal.blocked audited even with credits").

import { type SuppressionKeys, type Tx, suppressionRepository } from "@leadwolf/db";
import { SuppressedError } from "@leadwolf/types";

export type { SuppressionKeys };

export async function assertNotSuppressed(tx: Tx, keys: SuppressionKeys): Promise<void> {
  const hit = await suppressionRepository.findMatch(tx, keys);
  if (hit) {
    throw new SuppressedError(`${hit.scope}:${hit.matchType}${hit.reason ? `:${hit.reason}` : ""}`);
  }
}
