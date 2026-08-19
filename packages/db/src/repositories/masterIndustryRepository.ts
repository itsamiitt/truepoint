// masterIndustryRepository.ts — reads over the industry taxonomy (0128, MI-S3). Reference data:
// callable under EITHER role's transaction (both hold SELECT); the one write path (stamping a resolved
// node onto master_companies) runs under withErTx like every other landing write.

import { sql } from "drizzle-orm";
import type { Tx } from "../client.ts";

export interface IndustryNode {
  id: string;
  parentId: string | null;
  code: string;
  label: string;
}

export const masterIndustryRepository = {
  /** Resolve a vendor spelling to its canonical node id (citext alias match). Null = uncurated spelling. */
  async resolveIdForLabel(tx: Tx, label: string): Promise<string | null> {
    const trimmed = label.trim();
    if (!trimmed) return null;
    const rows = (await tx.execute(
      sql`SELECT industry_id FROM master_industry_aliases WHERE alias = ${trimmed}::citext LIMIT 1`,
    )) as unknown as Array<{ industry_id: string }>;
    return rows[0]?.industry_id ?? null;
  },

  /** The whole tree (≤ a few dozen rows) — the facet-label + curation read. */
  async listAll(tx: Tx): Promise<IndustryNode[]> {
    const rows = (await tx.execute(
      sql`SELECT id, parent_id, code, label FROM master_industries ORDER BY parent_id NULLS FIRST, label`,
    )) as unknown as Array<{ id: string; parent_id: string | null; code: string; label: string }>;
    return rows.map((r) => ({ id: r.id, parentId: r.parent_id, code: r.code, label: r.label }));
  },

  /** Stamp the resolved node onto a master company (derived column — never fold-governed). */
  async setCompanyIndustry(tx: Tx, masterCompanyId: string, industryId: string): Promise<void> {
    await tx.execute(
      sql`UPDATE master_companies SET industry_id = ${industryId}::uuid
           WHERE id = ${masterCompanyId}::uuid AND industry_id IS DISTINCT FROM ${industryId}::uuid`,
    );
  },
};
