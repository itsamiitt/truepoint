// health.test.ts — proves the workers health endpoint: /health is always live, /ready reflects the
// readiness flag (200 ↔ 503), unknown paths 404, and (0.3/F14) the Redis probe flips /ready only after N
// CONSECUTIVE failures and recovers on the first success. Uses ephemeral ports; no DB/Redis needed.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { DEFAULT_PROBE_FAILURE_THRESHOLD, startHealthServer } from "./health.ts";

let server: ReturnType<typeof startHealthServer>;
let ready = true;

beforeAll(() => {
  server = startHealthServer(() => ready, 0); // port 0 → Bun picks a free port
});
afterAll(() => {
  server?.stop(true);
});

test("/health is always 200 (liveness)", async () => {
  const r = await fetch(`http://localhost:${server.port}/health`);
  expect(r.status).toBe(200);
});

test("/ready reflects the readiness flag", async () => {
  ready = true;
  expect((await fetch(`http://localhost:${server.port}/ready`)).status).toBe(200);
  ready = false;
  expect((await fetch(`http://localhost:${server.port}/ready`)).status).toBe(503);
  ready = true;
});

test("unknown path is 404", async () => {
  expect((await fetch(`http://localhost:${server.port}/nope`)).status).toBe(404);
});

test("probe: /ready flips to 503 only after the consecutive-failure threshold (F14, no blip-flap)", async () => {
  let probeOk = false;
  const s = startHealthServer(() => true, 0, () => Promise.resolve(probeOk), 3);
  try {
    // Failures 1 and 2 ride out as 200 — restraint, so one Redis blip can't flap every replica at once.
    expect((await fetch(`http://localhost:${s.port}/ready`)).status).toBe(200);
    expect((await fetch(`http://localhost:${s.port}/ready`)).status).toBe(200);
    // Failure 3 crosses the threshold → 503 until the probe recovers.
    expect((await fetch(`http://localhost:${s.port}/ready`)).status).toBe(503);
    expect((await fetch(`http://localhost:${s.port}/ready`)).status).toBe(503);
    // First success resets the counter and readiness.
    probeOk = true;
    expect((await fetch(`http://localhost:${s.port}/ready`)).status).toBe(200);
    // A single new failure after recovery is again ridden out.
    probeOk = false;
    expect((await fetch(`http://localhost:${s.port}/ready`)).status).toBe(200);
  } finally {
    s.stop(true);
  }
});

test("probe: a throwing probe counts as a failure, never crashes the endpoint", async () => {
  const s = startHealthServer(() => true, 0, () => Promise.reject(new Error("wedged")), 1);
  try {
    expect((await fetch(`http://localhost:${s.port}/ready`)).status).toBe(503);
    // Liveness is unaffected by the probe.
    expect((await fetch(`http://localhost:${s.port}/health`)).status).toBe(200);
  } finally {
    s.stop(true);
  }
});

test("probe: draining wins — /ready is 503 for a drain regardless of probe state", async () => {
  let draining = false;
  const s = startHealthServer(() => !draining, 0, () => Promise.resolve(true));
  try {
    expect((await fetch(`http://localhost:${s.port}/ready`)).status).toBe(200);
    draining = true;
    expect((await fetch(`http://localhost:${s.port}/ready`)).status).toBe(503);
  } finally {
    s.stop(true);
  }
});

test("default threshold is 3 (documented restraint)", () => {
  expect(DEFAULT_PROBE_FAILURE_THRESHOLD).toBe(3);
});
