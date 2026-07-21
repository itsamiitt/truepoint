// apiImportsGate.ts — the P5 API-PUSH imports DUAL-GATE evaluator (import-and-data-model-redesign 08 §9;
// 14 Phase 5). Mirrors scheduledImportGate.ts / channelDualWrite.ts EXACTLY — a fail-closed dual gate over the
// API_IMPORTS_ENABLED env kill-switch AND the per-tenant `api_imports_enabled` feature flag (seeded off in
// migration 0069). FAIL-CLOSED at every layer:
//   effective = env.API_IMPORTS_ENABLED (global kill-switch, explicit-"true"-only)
//               AND the per-tenant `api_imports_enabled` flag (unknown/unreadable ⇒ off).
// While the ENV layer is off this performs ZERO queries. The `POST /imports/rows` verb gate-on-404s via
// `apiImportsEnabledForScope` (the S-I8 no-existence-oracle posture: gate-off ⇒ the endpoint is invisible
// until the tenant is enabled), so every other import surface is byte-identical (a NEW additive route).

import { env } from "@leadwolf/config";
import { type Tx, withTenantTx } from "@leadwolf/db";
import { API_IMPORTS_FLAG_KEY } from "@leadwolf/types";
import { isFlagEnabledForTenant } from "../featureFlags/flagsForTenant.ts";

/** Evaluate the API-push dual gate INSIDE an existing tenant tx. Env layer off ⇒ false with zero queries; a
 *  flag-read failure propagates with the caller's tx (never catch inside an aborted tx). */
export async function isApiImportsEnabled(tx: Tx, tenantId: string): Promise<boolean> {
  if (!env.API_IMPORTS_ENABLED) return false;
  return isFlagEnabledForTenant(tx, tenantId, API_IMPORTS_FLAG_KEY);
}

/** Evaluate the API-push dual gate ONCE in its own scoped tx (the route's gate-on-404 check). FAIL-CLOSED on
 *  error: a flag-read hiccup reads as OFF (the verb 404s) rather than leaking an existence oracle or half-
 *  admitting a programmatic write — the tightest posture for a public-surface write verb. */
export async function apiImportsEnabledForScope(scope: {
  tenantId: string;
  workspaceId: string;
}): Promise<boolean> {
  if (!env.API_IMPORTS_ENABLED) return false;
  try {
    return await withTenantTx(scope, (tx) =>
      isFlagEnabledForTenant(tx, scope.tenantId, API_IMPORTS_FLAG_KEY),
    );
  } catch (err) {
    console.error("[api-imports] flag read failed; treating as disabled (fail-closed)", err);
    return false;
  }
}
