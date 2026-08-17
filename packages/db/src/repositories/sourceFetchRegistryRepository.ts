// sourceFetchRegistryRepository.ts — data access for the Layer-0 URL fetch registry (0118). Every function
// takes the CALLER's tx: the capture route + the on-view path run under withPrivilegedTx (owner; the table
// is app-REVOKEd), and the worker sweep the same. Holds URLs + ids only — no PII, no tenant scope.

import { sql } from "drizzle-orm";
import type { Tx } from "../client.ts";

export interface RegisterUrlInput {
  entityKind: "person" | "company";
  normalizedUrl: string;
  externalId?: string | null;
  sourceName?: string;
}

export interface DueUrl {
  id: string;
  entityKind: "person" | "company";
  normalizedUrl: string;
  externalId: string | null;
}

export interface RegistryRow {
  id: string;
  lastFetchedAt: Date | null;
  fetchCount: number;
}

export const sourceFetchRegistryRepository = {
  /** Upsert a URL as a fetch target. First-seen only — NEVER moves last_fetched_at (that is the fetch
   *  clock, advanced solely by recordFetch). Returns the row id + current freshness for the on-view path. */
  async registerUrl(tx: Tx, input: RegisterUrlInput): Promise<RegistryRow> {
    const rows = (await tx.execute(sql`
      INSERT INTO source_fetch_registry (entity_kind, normalized_url, external_id, source_name)
      VALUES (${input.entityKind}, ${input.normalizedUrl}, ${input.externalId ?? null},
              ${input.sourceName ?? "linkedin_api"})
      ON CONFLICT (entity_kind, normalized_url)
      DO UPDATE SET
        external_id = COALESCE(source_fetch_registry.external_id, EXCLUDED.external_id),
        updated_at  = now()
      RETURNING id, last_fetched_at, fetch_count
    `)) as unknown as Array<{
      id: string;
      last_fetched_at: string | Date | null;
      fetch_count: number;
    }>;
    const r = rows[0]!;
    // Raw execute returns timestamptz as a string; normalize to Date so callers can do date math.
    const last = r.last_fetched_at == null ? null : new Date(r.last_fetched_at);
    return { id: r.id, lastFetchedAt: last, fetchCount: r.fetch_count };
  },

  /** The sweep read: per-kind, never-fetched first, then stalest past the freshness window. */
  async listDueForFetch(
    tx: Tx,
    entityKind: "person" | "company",
    olderThanDays: number,
    limit: number,
  ): Promise<DueUrl[]> {
    const rows = (await tx.execute(sql`
      SELECT id, entity_kind, normalized_url, external_id
        FROM source_fetch_registry
       WHERE entity_kind = ${entityKind}
         AND (last_fetched_at IS NULL
              OR last_fetched_at < now() - (${olderThanDays} || ' days')::interval)
       ORDER BY last_fetched_at ASC NULLS FIRST
       LIMIT ${limit}
    `)) as unknown as Array<{
      id: string;
      entity_kind: "person" | "company";
      normalized_url: string;
      external_id: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      entityKind: r.entity_kind,
      normalizedUrl: r.normalized_url,
      externalId: r.external_id,
    }));
  },

  /** Stamp a fetch attempt: advance the clock, bump the count, record the outcome + resolved golden ids.
   *  Written whatever happened (ok/rejected/unavailable) so a failing URL still moves off the sweep head. */
  async recordFetch(
    tx: Tx,
    id: string,
    outcome: "ok" | "rejected" | "unavailable",
    resolved?: { personId?: string | null; companyId?: string | null },
  ): Promise<void> {
    await tx.execute(sql`
      UPDATE source_fetch_registry
         SET last_fetched_at = now(),
             last_outcome = ${outcome},
             fetch_count = fetch_count + 1,
             resolved_person_id = COALESCE(${resolved?.personId ?? null}, resolved_person_id),
             resolved_company_id = COALESCE(${resolved?.companyId ?? null}, resolved_company_id),
             updated_at = now()
       WHERE id = ${id}
    `);
  },

  /** On-view short-circuit: is this URL fetched within the window? Null row ⇒ not fresh (must fetch). */
  async isFresh(
    tx: Tx,
    entityKind: "person" | "company",
    normalizedUrl: string,
    days: number,
  ): Promise<boolean> {
    const rows = (await tx.execute(sql`
      SELECT 1 AS ok FROM source_fetch_registry
       WHERE entity_kind = ${entityKind} AND normalized_url = ${normalizedUrl}
         AND last_fetched_at IS NOT NULL
         AND last_fetched_at >= now() - (${days} || ' days')::interval
       LIMIT 1
    `)) as unknown as Array<{ ok: number }>;
    return rows.length > 0;
  },
};
