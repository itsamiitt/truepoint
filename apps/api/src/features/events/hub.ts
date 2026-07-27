// hub.ts — ONE Redis subscriber per API process, fanned out in-process to every SSE stream.
//
// The route used to open a dedicated IORedis client per connection, because a client in subscribe mode cannot
// run other commands. That is correct per-client and ruinous in aggregate: 10k connected dashboards meant 10k
// Redis connections from one process, against a server whose default `maxclients` is 10000 — so the failure
// mode is not "slow", it is "no further connections, including the queues".
//
// Refcounted per-channel SUBSCRIBE, deliberately not PSUBSCRIBE. A pattern like `ws:*` would be one
// subscription, but it would also deliver EVERY workspace's events to EVERY api process, which then discards
// almost all of them — wasted bandwidth in proportion to tenant count, and a cross-tenant exposure that rests
// entirely on the in-process filter being right. Subscribing to exactly the channels this process has live
// listeners for means Redis does the isolation, and a filter bug cannot leak what was never delivered.

import type { Redis } from "ioredis";

export type RealtimeListener = (message: string) => void;

export interface RealtimeHub {
  /** Attach to a channel; resolves to the detach function. */
  subscribe(channel: string, listener: RealtimeListener): Promise<() => void>;
  /** Live channel count — for tests and the ops probe. */
  channelCount(): number;
}

interface ChannelState {
  listeners: Set<RealtimeListener>;
  /** Serializes SUBSCRIBE/UNSUBSCRIBE for this channel so a detach racing an attach cannot leave Redis
   *  subscribed with no listeners, or unsubscribed with listeners still waiting. */
  chain: Promise<void>;
}

export function createRealtimeHub(client: Redis): RealtimeHub {
  const channels = new Map<string, ChannelState>();

  client.on("message", (channel: string, message: string) => {
    const state = channels.get(channel);
    if (!state) return;
    // Copy before iterating: a listener may detach itself on a malformed payload, and mutating the Set during
    // iteration would skip its neighbour.
    for (const listener of [...state.listeners]) {
      try {
        listener(message);
      } catch {
        // One stream's failure must never stop delivery to the others sharing this connection — the whole
        // point of the shared subscriber is that these streams are now coupled.
      }
    }
  });

  return {
    channelCount: () => channels.size,

    async subscribe(channel, listener) {
      let state = channels.get(channel);
      if (!state) {
        state = { listeners: new Set(), chain: Promise.resolve() };
        channels.set(channel, state);
      }
      const s = state;
      s.listeners.add(listener);
      // First listener for this channel → actually subscribe. Chained so it cannot interleave with a
      // concurrent unsubscribe for the same channel.
      if (s.listeners.size === 1) {
        s.chain = s.chain.then(() => client.subscribe(channel).then(() => undefined));
      }
      await s.chain;

      let detached = false;
      return () => {
        if (detached) return; // detaching twice must not decrement someone else's refcount
        detached = true;
        s.listeners.delete(listener);
        if (s.listeners.size === 0) {
          channels.delete(channel);
          s.chain = s.chain.then(() =>
            client
              .unsubscribe(channel)
              .then(() => undefined)
              // An unsubscribe that fails leaves this process receiving a channel nobody listens to; the
              // message handler drops it (no state entry), so it is wasted bandwidth, never a leak.
              .catch(() => undefined),
          );
        }
      };
    },
  };
}

/** Per-user cap on concurrent streams. A single browser opens one per tab, and a script can open many more —
 *  without a cap one user can exhaust the process's stream budget for everyone. */
export function createConnectionCap(max: number) {
  const counts = new Map<string, number>();
  return {
    /** Returns a release function, or null when the user is already at the cap. */
    acquire(userId: string): (() => void) | null {
      const current = counts.get(userId) ?? 0;
      if (current >= max) return null;
      counts.set(userId, current + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const next = (counts.get(userId) ?? 1) - 1;
        if (next <= 0) counts.delete(userId);
        else counts.set(userId, next);
      };
    },
    countFor: (userId: string) => counts.get(userId) ?? 0,
  };
}
