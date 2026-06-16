// health.test.ts — proves the workers health endpoint: /health is always live, /ready reflects the
// readiness flag (200 ↔ 503), unknown paths 404. Uses an ephemeral port; no DB/Redis needed.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHealthServer } from "./health.ts";

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
