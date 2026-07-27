// hub.test.ts — the shared SSE subscriber. What matters is the refcounting: one Redis SUBSCRIBE per channel
// no matter how many streams attach, an UNSUBSCRIBE exactly when the last one leaves, and no cross-channel
// delivery. Those are the properties that let one connection replace one-per-client.

import { describe, expect, test } from "bun:test";
import { createConnectionCap, createRealtimeHub } from "./hub.ts";

/** Minimal ioredis stand-in: records subscribe/unsubscribe and can emit messages. */
function fakeRedis() {
  const calls: Array<{ op: "subscribe" | "unsubscribe"; channel: string }> = [];
  let handler: ((channel: string, message: string) => void) | undefined;
  const client = {
    on(event: string, fn: (channel: string, message: string) => void) {
      if (event === "message") handler = fn;
    },
    async subscribe(channel: string) {
      calls.push({ op: "subscribe", channel });
      return 1;
    },
    async unsubscribe(channel: string) {
      calls.push({ op: "unsubscribe", channel });
      return 0;
    },
  };
  return {
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub, not the full ioredis surface.
    client: client as any,
    calls,
    emit: (channel: string, message: string) => handler?.(channel, message),
  };
}

describe("createRealtimeHub", () => {
  test("many listeners on one channel produce exactly ONE Redis subscribe", async () => {
    // The entire point: 10k dashboards on a workspace must not mean 10k Redis connections or subscriptions.
    const { client, calls } = fakeRedis();
    const hub = createRealtimeHub(client);
    await hub.subscribe("ws:a", () => {});
    await hub.subscribe("ws:a", () => {});
    await hub.subscribe("ws:a", () => {});
    expect(calls.filter((c) => c.op === "subscribe")).toHaveLength(1);
    expect(hub.channelCount()).toBe(1);
  });

  test("a message fans out to every listener on that channel", async () => {
    const { client, emit } = fakeRedis();
    const hub = createRealtimeHub(client);
    const seen: string[] = [];
    await hub.subscribe("ws:a", (m) => seen.push(`1:${m}`));
    await hub.subscribe("ws:a", (m) => seen.push(`2:${m}`));
    emit("ws:a", "hello");
    expect(seen).toEqual(["1:hello", "2:hello"]);
  });

  test("channels are isolated — a listener never sees another workspace's messages", async () => {
    const { client, emit } = fakeRedis();
    const hub = createRealtimeHub(client);
    const a: string[] = [];
    const b: string[] = [];
    await hub.subscribe("ws:a", (m) => a.push(m));
    await hub.subscribe("ws:b", (m) => b.push(m));
    emit("ws:a", "for-a");
    expect(a).toEqual(["for-a"]);
    expect(b).toEqual([]);
  });

  test("unsubscribe happens only when the LAST listener leaves", async () => {
    const { client, calls } = fakeRedis();
    const hub = createRealtimeHub(client);
    const off1 = await hub.subscribe("ws:a", () => {});
    const off2 = await hub.subscribe("ws:a", () => {});
    off1();
    expect(calls.filter((c) => c.op === "unsubscribe")).toHaveLength(0);
    off2();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.filter((c) => c.op === "unsubscribe")).toHaveLength(1);
    expect(hub.channelCount()).toBe(0);
  });

  test("detaching twice does not decrement another stream's refcount", async () => {
    // A stream can abort and then be cleaned up again; a double release would unsubscribe a channel that
    // still has live listeners, silently stopping their events.
    const { client, calls, emit } = fakeRedis();
    const hub = createRealtimeHub(client);
    const off1 = await hub.subscribe("ws:a", () => {});
    const seen: string[] = [];
    await hub.subscribe("ws:a", (m) => seen.push(m));
    off1();
    off1();
    off1();
    expect(calls.filter((c) => c.op === "unsubscribe")).toHaveLength(0);
    emit("ws:a", "still-delivered");
    expect(seen).toEqual(["still-delivered"]);
  });

  test("a throwing listener does not stop delivery to the others", async () => {
    // The shared subscriber couples these streams; one bad payload handler must not take the rest down.
    const { client, emit } = fakeRedis();
    const hub = createRealtimeHub(client);
    const seen: string[] = [];
    await hub.subscribe("ws:a", () => {
      throw new Error("bad handler");
    });
    await hub.subscribe("ws:a", (m) => seen.push(m));
    emit("ws:a", "payload");
    expect(seen).toEqual(["payload"]);
  });

  test("re-subscribing after the channel emptied issues a fresh subscribe", async () => {
    const { client, calls } = fakeRedis();
    const hub = createRealtimeHub(client);
    const off = await hub.subscribe("ws:a", () => {});
    off();
    await Promise.resolve();
    await hub.subscribe("ws:a", () => {});
    expect(calls.filter((c) => c.op === "subscribe")).toHaveLength(2);
  });
});

describe("createConnectionCap", () => {
  test("allows up to the cap, then refuses", () => {
    const cap = createConnectionCap(2);
    expect(cap.acquire("u1")).not.toBeNull();
    expect(cap.acquire("u1")).not.toBeNull();
    expect(cap.acquire("u1")).toBeNull();
  });

  test("the cap is per user — one user cannot exhaust another's budget", () => {
    const cap = createConnectionCap(1);
    expect(cap.acquire("u1")).not.toBeNull();
    expect(cap.acquire("u2")).not.toBeNull();
  });

  test("releasing frees a slot, and releasing twice does not free two", () => {
    const cap = createConnectionCap(1);
    const release = cap.acquire("u1");
    expect(cap.acquire("u1")).toBeNull();
    release?.();
    release?.();
    expect(cap.countFor("u1")).toBe(0);
    expect(cap.acquire("u1")).not.toBeNull();
    expect(cap.acquire("u1")).toBeNull(); // the double release did not inflate the budget
  });
});
