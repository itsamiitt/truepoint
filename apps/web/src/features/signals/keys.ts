// keys.ts — react-query keys for the Signals slice.

export const signalKeys = {
  feed: (accountId?: string) => ["signals", "feed", accountId ?? "all"] as const,
  watchlists: () => ["signals", "watchlists"] as const,
};
