// intentSignalRepository.ts — data access for weighted intent signals (scoring domain, 03 §6). Signals
// feed the intent component of the lead score; they are workspace-private and never gate reveals/sends.

import type { SignalType } from "@leadwolf/types";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { contacts } from "../schema/contacts.ts";
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

/** A firmographic-bearing signal joined to its contact's account (24 Phase-0.5 rollup input). */
export interface FirmographicSignalRow {
  accountId: string;
  signalType: string;
  detail: string | null;
  detectedAt: Date;
}

/** The signal types that carry firmographic facet data (tech installs → technologies; funding → stage). */
const FIRMOGRAPHIC_SIGNAL_TYPES = ["tech_install", "funding_round"];

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

  /**
   * All firmographic-bearing signals in the workspace, joined to each signal's contact → account (24 Phase-0.5).
   * Feeds the firmographics rollup (tech_install → accounts.technologies; funding_round → accounts.funding_stage).
   * Workspace-scoped via RLS (both intent_signals and contacts are gated by the caller's tx). Tombstoned
   * contacts and accountless contacts are excluded. Newest-first so the rollup can pick the latest funding round.
   */
  async firmographicSignals(tx: Tx): Promise<FirmographicSignalRow[]> {
    const rows = await tx
      .select({
        accountId: contacts.accountId,
        signalType: intentSignals.signalType,
        detail: intentSignals.detail,
        detectedAt: intentSignals.detectedAt,
      })
      .from(intentSignals)
      .innerJoin(contacts, eq(contacts.id, intentSignals.contactId))
      .where(
        and(
          inArray(intentSignals.signalType, FIRMOGRAPHIC_SIGNAL_TYPES),
          isNotNull(contacts.accountId),
          isNull(contacts.deletedAt),
        ),
      )
      .orderBy(desc(intentSignals.detectedAt));
    // accountId is non-null by the WHERE guard; narrow the type for the caller.
    return rows.map((r) => ({
      accountId: r.accountId as string,
      signalType: r.signalType,
      detail: r.detail,
      detectedAt: r.detectedAt,
    }));
  },
};
