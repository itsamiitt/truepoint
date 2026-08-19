// watchlists.ts — contracts for account watchlists + signal subscriptions + the tenant signal feed
// (market-intelligence MI-S5/MI-S6; mounted at /api/v1/watchlists and /api/v1/signals). Shared by
// apps/api (validates) and apps/web (derives view types).
//
// signalFamily is the SAME closed vocabulary as master_signal_types (0103) / tenant_signals (0125) /
// signal_subscriptions (0126) — and like all of them, deliberately NO 'intent' (deferred non-goal X-04).

import { z } from "zod";

export const signalFamily = z.enum([
  "hiring",
  "funding",
  "tech_change",
  "leadership",
  "filing",
  "other",
]);
export type SignalFamily = z.infer<typeof signalFamily>;

// ── Watchlists ───────────────────────────────────────────────────────────────────────────────────────────
export const createWatchlistSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

export const addWatchlistMemberSchema = z.object({
  accountId: z.string().uuid(),
});

export const signalSubscribeSchema = z.object({
  /** Empty array = paused (row kept). */
  families: z.array(signalFamily).max(6),
});

export const watchlistSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  memberCount: z.number().int().min(0),
  createdAt: z.string(),
});
export type Watchlist = z.infer<typeof watchlistSchema>;

export const watchlistsResponse = z.object({ watchlists: z.array(watchlistSchema) });

// ── The signal feed ──────────────────────────────────────────────────────────────────────────────────────
export const tenantSignalSchema = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid().nullable(),
  contactId: z.string().uuid().nullable(),
  typeCode: z.string(),
  family: signalFamily,
  headline: z.string().nullable(),
  amountMinor: z.number().nullable(),
  currency: z.string().nullable(),
  observedAt: z.string(),
  deliveredAt: z.string(),
});
export type TenantSignal = z.infer<typeof tenantSignalSchema>;

export const signalFeedResponse = z.object({ signals: z.array(tenantSignalSchema) });
