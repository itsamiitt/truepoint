// subProcessorRepository.ts — data access for sub_processors (the GDPR Art. 28 sub-processor registry, 13 §3.8).
// Every method takes the transaction handed by withPlatformTx (owner connection, audited). create/update by id.
// Reads are bounded — no unbounded scans (ADR-0032). Mirrors retentionPolicyRepository (the sibling Area-8 config).

import { asc, eq, sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { subProcessors } from "../schema/platformOps.ts";

export interface SubProcessorRow {
  id: string;
  name: string;
  purpose: string;
  location: string;
  dpaUrl: string | null;
  active: boolean;
  sortOrder: number;
  updatedAt: Date;
}

export interface SubProcessorWrite {
  name: string;
  purpose: string;
  location: string;
  dpaUrl: string | null;
  sortOrder: number;
}

const LIMIT = 200;

const COLS = {
  id: subProcessors.id,
  name: subProcessors.name,
  purpose: subProcessors.purpose,
  location: subProcessors.location,
  dpaUrl: subProcessors.dpaUrl,
  active: subProcessors.active,
  sortOrder: subProcessors.sortOrder,
  updatedAt: subProcessors.updatedAt,
};

export const subProcessorRepository = {
  /** The full list (active + removed), ordered by sort_order then name, bounded. */
  async list(tx: Tx): Promise<SubProcessorRow[]> {
    return tx
      .select(COLS)
      .from(subProcessors)
      .orderBy(asc(subProcessors.sortOrder), asc(subProcessors.name))
      .limit(LIMIT);
  },

  /** Create a sub-processor (active by default). */
  async create(
    tx: Tx,
    input: SubProcessorWrite & { createdByUserId: string },
  ): Promise<SubProcessorRow> {
    const [row] = await tx
      .insert(subProcessors)
      .values({
        name: input.name,
        purpose: input.purpose,
        location: input.location,
        dpaUrl: input.dpaUrl,
        sortOrder: input.sortOrder,
        createdByUserId: input.createdByUserId,
      })
      .returning(COLS);
    return row as SubProcessorRow;
  },

  /** Update a sub-processor by id. Returns rows touched (0 = unknown id → caller raises 404). */
  async update(tx: Tx, id: string, input: SubProcessorWrite): Promise<number> {
    const updated = await tx
      .update(subProcessors)
      .set({
        name: input.name,
        purpose: input.purpose,
        location: input.location,
        dpaUrl: input.dpaUrl,
        sortOrder: input.sortOrder,
        updatedAt: sql`now()`,
      })
      .where(eq(subProcessors.id, id))
      .returning({ id: subProcessors.id });
    return updated.length;
  },

  /** Toggle a sub-processor on/off (remove from / restore to the published registry). Returns rows touched. */
  async setActive(tx: Tx, id: string, active: boolean): Promise<number> {
    const updated = await tx
      .update(subProcessors)
      .set({ active, updatedAt: sql`now()` })
      .where(eq(subProcessors.id, id))
      .returning({ id: subProcessors.id });
    return updated.length;
  },
};
