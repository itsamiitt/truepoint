// creditPackRepository.ts — data access for credit_packs (13a Area 5, pricing config). Every method takes the
// transaction handed by withPlatformTx (owner connection, audited). Upsert is keyed on the natural `key`, so
// re-authoring a pack is idempotent. Reads are bounded — no unbounded scans (ADR-0032).

import { and, asc, eq, sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { creditPacks } from "../schema/platformOps.ts";

export interface CreditPackRow {
  key: string;
  name: string;
  credits: number;
  priceCents: number;
  stripePriceId: string | null;
  active: boolean;
  sortOrder: number;
  updatedAt: Date;
}

export interface UpsertCreditPackInput {
  key: string;
  name: string;
  credits: number;
  priceCents: number;
  stripePriceId?: string | null;
  sortOrder: number;
}

const PACK_LIMIT = 200;

const PACK_COLS = {
  key: creditPacks.key,
  name: creditPacks.name,
  credits: creditPacks.credits,
  priceCents: creditPacks.priceCents,
  stripePriceId: creditPacks.stripePriceId,
  active: creditPacks.active,
  sortOrder: creditPacks.sortOrder,
  updatedAt: creditPacks.updatedAt,
};

export const creditPackRepository = {
  /** The full catalog (active + retired), ordered by sortOrder then name, bounded. */
  async list(tx: Tx): Promise<CreditPackRow[]> {
    return tx
      .select(PACK_COLS)
      .from(creditPacks)
      .orderBy(asc(creditPacks.sortOrder), asc(creditPacks.name))
      .limit(PACK_LIMIT);
  },

  /** ACTIVE packs only, ordered for display — the public, transparent pricing catalog (ADR-0012). Read on the
   *  owner connection via withPlatformReadTx for the unauthenticated pricing page; never exposes retired packs. */
  async listActive(tx: Tx): Promise<CreditPackRow[]> {
    return tx
      .select(PACK_COLS)
      .from(creditPacks)
      .where(eq(creditPacks.active, true))
      .orderBy(asc(creditPacks.sortOrder), asc(creditPacks.name))
      .limit(PACK_LIMIT);
  },

  /** One ACTIVE pack by key — the checkout lookup (M11, ADR-0041). Owner read; null when unknown/retired. */
  async getActiveByKey(tx: Tx, key: string): Promise<CreditPackRow | null> {
    const [row] = await tx
      .select(PACK_COLS)
      .from(creditPacks)
      .where(and(eq(creditPacks.key, key), eq(creditPacks.active, true)))
      .limit(1);
    return (row as CreditPackRow) ?? null;
  },

  /** Create or update a pack (idempotent on `key`). An update keeps `active` (toggled separately) but bumps
   *  updated_at; an insert defaults active=true. `stripePriceId` is set only when provided. Returns the row. */
  async upsert(tx: Tx, input: UpsertCreditPackInput): Promise<CreditPackRow> {
    const [row] = await tx
      .insert(creditPacks)
      .values({
        key: input.key,
        name: input.name,
        credits: input.credits,
        priceCents: input.priceCents,
        stripePriceId: input.stripePriceId ?? null,
        sortOrder: input.sortOrder,
      })
      .onConflictDoUpdate({
        target: creditPacks.key,
        set: {
          name: input.name,
          credits: input.credits,
          priceCents: input.priceCents,
          ...(input.stripePriceId !== undefined ? { stripePriceId: input.stripePriceId } : {}),
          sortOrder: input.sortOrder,
          updatedAt: sql`now()`,
        },
      })
      .returning(PACK_COLS);
    return row as CreditPackRow;
  },

  /** Toggle a pack's availability. Returns the rows touched (0 = unknown key → caller raises 404). */
  async setActive(tx: Tx, key: string, active: boolean): Promise<number> {
    const updated = await tx
      .update(creditPacks)
      .set({ active, updatedAt: sql`now()` })
      .where(eq(creditPacks.key, key))
      .returning({ key: creditPacks.key });
    return updated.length;
  },
};
