// intentSignalRepository.ts — data access for weighted intent signals (scoring domain, 03 §6). Signals
// feed the intent component of the lead score; they are workspace-private and never gate reveals/sends.

import type { SignalType } from "@leadwolf/types";
import { desc, eq } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { intentSignals } from "../schema/intel.ts";

export interface IntentSignalInsert {
  tenantId: string;
  workspaceId: string;
  contactId: string;
  signalType: SignalType;
  signalSource?: string | null;
  detail?: string | null;
  weight: number; // 1–10
}

export interface IntentSignalRow {
  signalType: string;
  weight: number;
  detectedAt: Date;
}

export const intentSignalRepository = {
  async insert(tx: Tx, signal: IntentSignalInsert): Promise<string> {
    const rows = await tx.insert(intentSignals).values(signal).returning({ id: intentSignals.id });
    return rows[0]!.id;
  },

  /** Recent signals for a contact, newest first — the scoring input (tx-aware: composed in the score tx). */
  async recentForContact(tx: Tx, contactId: string, limit = 50): Promise<IntentSignalRow[]> {
    return tx
      .select({
        signalType: intentSignals.signalType,
        weight: intentSignals.weight,
        detectedAt: intentSignals.detectedAt,
      })
      .from(intentSignals)
      .where(eq(intentSignals.contactId, contactId))
      .orderBy(desc(intentSignals.detectedAt))
      .limit(limit);
  },
};
