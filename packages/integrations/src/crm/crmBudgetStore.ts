// crmBudgetStore.ts — the Redis-backed CrmBudgetStore (crm-sync 00 §8.2 inversion 1).
//
// SHARED ACROSS PROCESSES is the whole point. Workers are horizontally scaled, so a process-local counter
// means N workers each grant the full budget and the real ceiling is N× what the operator configured. INCRBY
// on a shared key is the atomicity boundary the guard's increment-then-check relies on.
//
// This adapter deliberately does NOT swallow its own errors: the guard treats a throw as "budget unknown"
// and fails closed. An implementation that caught a Redis outage and returned 0 would silently convert the
// fail-closed posture into fail-open — the exact inversion §8.2 calls out.

/** The subset of ioredis this store needs, so the package does not take a hard client dependency. */
export interface CrmBudgetRedis {
  incrby(key: string, increment: number): Promise<number>;
  decrby(key: string, decrement: number): Promise<number>;
  get(key: string): Promise<string | null>;
  expire(key: string, seconds: number): Promise<number>;
  set(key: string, value: string, mode: "EX", seconds: number, exist: "NX"): Promise<string | null>;
}

/** Hourly windows expire after two hours — long enough to survive clock skew, short enough not to leak keys. */
const WINDOW_TTL_SECONDS = 2 * 60 * 60;

const keyFor = (connectionId: string, window: string) => `crm:budget:${connectionId}:${window}`;

export function redisCrmBudgetStore(redis: CrmBudgetRedis) {
  return {
    async increment(connectionId: string, window: string, cost: number): Promise<number> {
      const key = keyFor(connectionId, window);
      const total = await redis.incrby(key, cost);
      // Set the TTL only when the counter was just created (total === cost), so a long-running window is
      // never extended by later increments — otherwise a busy connection's key would never expire and the
      // window would effectively stop rolling.
      if (total === cost) await redis.expire(key, WINDOW_TTL_SECONDS);
      return total;
    },

    async decrement(connectionId: string, window: string, cost: number): Promise<void> {
      const key = keyFor(connectionId, window);
      const total = await redis.decrby(key, cost);
      // DECRBY can go negative if a refund races a window roll. Clamped so a later increment starts from
      // zero rather than from a negative floor that would silently grant extra budget.
      if (total < 0) await redis.set(key, "0", "EX", WINDOW_TTL_SECONDS, "NX");
    },

    async peek(connectionId: string, window: string): Promise<number> {
      const raw = await redis.get(keyFor(connectionId, window));
      return raw ? Number.parseInt(raw, 10) : 0;
    },
  };
}
