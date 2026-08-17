// providerOriginRepository.ts — data access for the data-source origin fleet (0117;
// docs/planning/linkedin-source-ingestion/ §origins). Every function takes the CALLER's tx:
// staff writes arrive under withPlatformTx (audited), fetch-layer reads under withPlatformReadTx
// (owner; provider_origins is app-REVOKEd because it holds encrypted keys).
//
// SECRETS DISCIPLINE: `api_key_enc` crosses this boundary as bytea ONLY — encryption/decryption is the
// CORE boundary's job (packages/db cannot import core's encryptPii). The masked view (`listForAdmin`)
// never selects the ciphertext; `listActiveWithKeys` is the ONE reader that does, and its only caller is
// the origin router's fetch path. The console gets `api_key_hint`, nothing else, ever.

import { sql } from "drizzle-orm";
import type { Tx } from "../client.ts";

export interface ProviderOriginActive {
  id: string;
  baseUrl: string;
  apiKeyEnc: Uint8Array | null;
}

export interface ProviderOriginAdminView {
  id: string;
  provider: string;
  label: string;
  baseUrl: string;
  apiKeyHint: string | null;
  priority: number;
  paused: boolean;
  lastOkAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  lastErrorAt: string | null;
}

export interface CreateOriginInput {
  provider: string;
  label: string;
  baseUrl: string;
  apiKeyEnc: Uint8Array | null;
  apiKeyHint: string | null;
  priority?: number;
}

export interface UpdateOriginInput {
  label?: string;
  baseUrl?: string;
  /** undefined = keep the stored key; null = clear it; bytes = replace it. */
  apiKeyEnc?: Uint8Array | null;
  apiKeyHint?: string | null;
  priority?: number;
}

export const providerOriginRepository = {
  /** The failover chain: unpaused origins in priority order, WITH ciphertext — fetch-path only. */
  async listActiveWithKeys(tx: Tx, provider: string): Promise<ProviderOriginActive[]> {
    const rows = (await tx.execute(sql`
      SELECT id, base_url, api_key_enc FROM provider_origins
       WHERE provider = ${provider} AND paused = false
       ORDER BY priority ASC, created_at ASC
    `)) as unknown as Array<{ id: string; base_url: string; api_key_enc: Uint8Array | null }>;
    return rows.map((r) => ({ id: r.id, baseUrl: r.base_url, apiKeyEnc: r.api_key_enc }));
  },

  /** The console view — masked: hint only, never the ciphertext. */
  async listForAdmin(tx: Tx, provider: string): Promise<ProviderOriginAdminView[]> {
    const rows = (await tx.execute(sql`
      SELECT id, provider, label, base_url, api_key_hint, priority, paused,
             last_ok_at, consecutive_failures, last_error, last_error_at
        FROM provider_origins
       WHERE provider = ${provider}
       ORDER BY priority ASC, created_at ASC
    `)) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      provider: r.provider as string,
      label: r.label as string,
      baseUrl: r.base_url as string,
      apiKeyHint: (r.api_key_hint as string | null) ?? null,
      priority: r.priority as number,
      paused: r.paused as boolean,
      lastOkAt: r.last_ok_at ? String(r.last_ok_at) : null,
      consecutiveFailures: r.consecutive_failures as number,
      lastError: (r.last_error as string | null) ?? null,
      lastErrorAt: r.last_error_at ? String(r.last_error_at) : null,
    }));
  },

  async create(tx: Tx, input: CreateOriginInput): Promise<string> {
    const rows = (await tx.execute(sql`
      INSERT INTO provider_origins (provider, label, base_url, api_key_enc, api_key_hint, priority)
      VALUES (${input.provider}, ${input.label}, ${input.baseUrl}, ${input.apiKeyEnc},
              ${input.apiKeyHint}, ${input.priority ?? 100})
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    return rows[0]!.id;
  },

  async update(tx: Tx, id: string, input: UpdateOriginInput): Promise<boolean> {
    // COALESCE-style partials, with the key handled explicitly: undefined keeps, null clears, bytes replace.
    const rows = (await tx.execute(sql`
      UPDATE provider_origins
         SET label       = COALESCE(${input.label ?? null}, label),
             base_url    = COALESCE(${input.baseUrl ?? null}, base_url),
             priority    = COALESCE(${input.priority ?? null}, priority),
             api_key_enc = CASE WHEN ${input.apiKeyEnc !== undefined} THEN ${input.apiKeyEnc ?? null} ELSE api_key_enc END,
             api_key_hint = CASE WHEN ${input.apiKeyEnc !== undefined} THEN ${input.apiKeyHint ?? null} ELSE api_key_hint END,
             updated_at  = now()
       WHERE id = ${id}
       RETURNING id
    `)) as unknown as Array<{ id: string }>;
    return rows.length > 0;
  },

  async setPaused(tx: Tx, id: string, paused: boolean): Promise<boolean> {
    const rows = (await tx.execute(sql`
      UPDATE provider_origins SET paused = ${paused}, updated_at = now()
       WHERE id = ${id} RETURNING id
    `)) as unknown as Array<{ id: string }>;
    return rows.length > 0;
  },

  async remove(tx: Tx, id: string): Promise<boolean> {
    const rows = (await tx.execute(
      sql`DELETE FROM provider_origins WHERE id = ${id} RETURNING id`,
    )) as unknown as Array<{ id: string }>;
    return rows.length > 0;
  },

  /** Passive health, written by the fetch layer after every attempt. Failure text is truncated —
   *  last_error is a console hint, not a log sink. */
  async recordOutcome(tx: Tx, id: string, ok: boolean, error?: string): Promise<void> {
    if (ok) {
      await tx.execute(sql`
        UPDATE provider_origins
           SET last_ok_at = now(), consecutive_failures = 0, last_error = NULL, last_error_at = NULL,
               updated_at = now()
         WHERE id = ${id}
      `);
      return;
    }
    await tx.execute(sql`
      UPDATE provider_origins
         SET consecutive_failures = consecutive_failures + 1,
             last_error = ${(error ?? "unknown error").slice(0, 500)},
             last_error_at = now(),
             updated_at = now()
       WHERE id = ${id}
    `);
  },
};
