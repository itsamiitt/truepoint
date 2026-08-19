// gateMemo.ts — two-layer memo for per-tenant GATE reads on hot request paths (perf-audit P2.4; made
// multi-instance-safe by launch-scale Phase 7 S6, arch doc §2 — the §4 consistency table classifies
// roles/flags/entitlement BASES as bounded-stale ≤30s with event invalidation; enforcement decisions and
// usage stay live and are never cached).
//
// Layer 1 is a 5-second in-process map — the fast path that keeps a Redis round-trip off every gated
// request. Layer 2 is the shared read-through tier (30s TTL), which is what makes an admin write visible
// across instances: a tenant-targeted write DELs its L2 key synchronously, so every other instance
// recomputes within its ≤5s L1 window (the old single-process assumption — "the api runs as one process
// today" — is retired; S7 scales instances). GLOBAL writes (flag definition/default changes, which the
// per-key sweeps cannot enumerate in Redis) INCR one gate GENERATION key folded into every L2 key — the
// same O(1) trick as the S5 search cache — and are rare, human-clicked admin actions.
//
// The SPEND-RELEASE gates (bulk-enrichment confirm, bulk-import submit) remain deliberately NOT memoized —
// rare human-clicked actions where a just-revoked flag must hold immediately. Workers read flags per JOB
// and keep reading the database.
//
// Failure semantics: a read() that throws is NOT cached — each gate keeps its own fail-open/fail-closed
// posture. Redis being unreachable degrades to L1-only (the tier and the generation read both fail open),
// i.e. exactly the pre-S6 behaviour.

import { type ReadThroughCache, tenantKey } from "@leadwolf/core";
import { cache, cacheRedis } from "../cache.ts";

const L1_TTL_MS = 5_000;
const L2_TTL_S = 30;
/** Global generation for ALL gate entries (raw key, beside the cache values it governs). INCR'd by the
 *  global invalidators; folded into every L2 key so they retire in O(1). */
const GATE_GEN_KEY = "cache:ver:gates";

interface Entry<T> {
  value: T;
  expiresAt: number;
}

// Injectable L2 seam (tests bind in-memory fakes; production lazily binds the api cache tier).
interface GateL2 {
  cache: ReadThroughCache;
  redis: { get(key: string): Promise<string | null>; incr(key: string): Promise<number> };
}
let l2Override: GateL2 | undefined;
const l2 = (): GateL2 => l2Override ?? { cache: cache(), redis: cacheRedis() };
export function setGateL2ForTests(binding: GateL2 | undefined): void {
  l2Override = binding;
}

async function gateGeneration(): Promise<string> {
  try {
    return (await l2().redis.get(GATE_GEN_KEY)) ?? "0";
  } catch {
    return "0"; // fail open — L2 getOrSet degrades to the loader on the same outage
  }
}

async function bumpGateGeneration(): Promise<void> {
  try {
    await l2().redis.incr(GATE_GEN_KEY);
  } catch {
    // swallowed: every L2 entry still expires on its 30s TTL
  }
}

// ── Flag gates (boolean per tenant + flag key) ─────────────────────────────────────────────────────────────
const flagMemo = new Map<string, Entry<boolean>>();
const flagKeyOf = (tenantId: string, flagKey: string) => `${tenantId}:${flagKey}`;
const flagL2Key = (gen: string, tenantId: string, flagKey: string) =>
  tenantKey({ tenantId }, "gate", `g${gen}`, "flag", flagKey);

/** Read a per-tenant gate through the memo layers. `read` runs only on an L1+L2 miss; errors propagate
 *  uncached. */
export async function flagGateCached(
  tenantId: string,
  flagKey: string,
  read: () => Promise<boolean>,
): Promise<boolean> {
  const k = flagKeyOf(tenantId, flagKey);
  const hit = flagMemo.get(k);
  const now = Date.now();
  if (hit && hit.expiresAt > now) return hit.value;
  const gen = await gateGeneration();
  const value = await l2().cache.getOrSet(flagL2Key(gen, tenantId, flagKey), L2_TTL_S, read);
  flagMemo.set(k, { value, expiresAt: now + L1_TTL_MS });
  return value;
}

/** Drop one tenant's memoized value for a flag — called after the admin tenant-override write commits.
 *  Clears this instance's L1 synchronously and the shared L2 entry; other instances converge ≤5s (L1). */
export function invalidateFlagGate(tenantId: string, flagKey: string): void {
  flagMemo.delete(flagKeyOf(tenantId, flagKey));
  void (async () => {
    try {
      await l2().cache.invalidate(flagL2Key(await gateGeneration(), tenantId, flagKey));
    } catch {
      // TTL backstop
    }
  })();
}

/** Drop EVERY tenant's memoized value for a flag — a global default/definition change affects them all.
 *  Redis keys are not enumerable by design, so this retires the whole gate namespace via the generation. */
export function invalidateFlagGateKey(flagKey: string): void {
  for (const k of flagMemo.keys()) if (k.endsWith(`:${flagKey}`)) flagMemo.delete(k);
  void bumpGateGeneration();
}

/** Drop every memoized flag gate. Used by the GLOBAL flag writes: composed gates (the channel-read port
 *  gate) memoize under a synthetic key that a per-key sweep cannot name, and a global toggle is a rare,
 *  human-clicked admin action — clearing everything is cheaper than being clever and stale. */
export function invalidateAllFlagGates(): void {
  flagMemo.clear();
  void bumpGateGeneration();
}

// ── Entitlement basis (grants + enforce flag per tenant; usage is NEVER cached) ──────────────────────────
// The basis changes on plan overrides and flag writes (the enforce switch rides the flag system); usage
// changes on every metered action and must stay live — requireEntitlement reads it per request regardless.
const basisMemo = new Map<string, Entry<unknown>>();
const basisL2Key = (gen: string, tenantId: string) =>
  tenantKey({ tenantId }, "gate", `g${gen}`, "basis");

export async function entitlementBasisCached<T>(
  tenantId: string,
  read: () => Promise<T>,
): Promise<T> {
  const hit = basisMemo.get(tenantId);
  const now = Date.now();
  if (hit && hit.expiresAt > now) return hit.value as T;
  const gen = await gateGeneration();
  const value = await l2().cache.getOrSet(basisL2Key(gen, tenantId), L2_TTL_S, read);
  basisMemo.set(tenantId, { value, expiresAt: now + L1_TTL_MS });
  return value;
}

/** Drop one tenant's entitlement basis — called after a plan override or that tenant's flag write commits. */
export function invalidateEntitlementBasis(tenantId: string): void {
  basisMemo.delete(tenantId);
  void (async () => {
    try {
      await l2().cache.invalidate(basisL2Key(await gateGeneration(), tenantId));
    } catch {
      // TTL backstop
    }
  })();
}

/** Drop every tenant's entitlement basis — a global flag/definition change can move the enforce switch. */
export function invalidateAllEntitlementBasis(): void {
  basisMemo.clear();
  void bumpGateGeneration();
}

/** Test seam: reset all gate memos (mirrors resetBreakers in core's waterfall). L1 only — tests that bind
 *  an L2 fake own its lifecycle via setGateL2ForTests. */
export function resetGateMemos(): void {
  flagMemo.clear();
  basisMemo.clear();
}
