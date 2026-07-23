// route.test.ts — the apps/auth /metrics scrape handler. Calls the REAL GET handler with a constructed Request,
// @leadwolf/config spread from the preload-seeded module with only env.METRICS_TOKEN overridden per case (a Proxy
// so a per-test reassignment is read live). Proves the same posture as the apps/api route: OFF by default (404),
// invisible to a wrong/absent token (404 — not 401), and only the exact Bearer secret renders Prometheus text.

import { describe, expect, it, mock } from "bun:test";
import * as realConfig from "@leadwolf/config";

let metricsToken: string | undefined;
mock.module("@leadwolf/config", () => ({
  ...realConfig,
  env: new Proxy(realConfig.env, {
    get: (target, prop) => (prop === "METRICS_TOKEN" ? metricsToken : Reflect.get(target, prop)),
  }),
}));

const { GET } = await import("./route.ts");
const TOKEN = "test-metrics-token-0123456789";
const req = (auth?: string) =>
  new Request("http://auth.test/metrics", auth ? { headers: { authorization: auth } } : {});

describe("GET /metrics (apps/auth)", () => {
  it("404s when METRICS_TOKEN is unset — off/invisible by default", async () => {
    metricsToken = undefined;
    expect((await GET(req(`Bearer ${TOKEN}`))).status).toBe(404);
  });

  it("404s on a wrong or absent token when enabled — never advertises its existence", async () => {
    metricsToken = TOKEN;
    expect((await GET(req())).status).toBe(404);
    expect((await GET(req("Bearer wrong"))).status).toBe(404);
  });

  it("renders Prometheus text for the exact Bearer secret", async () => {
    metricsToken = TOKEN;
    const res = await GET(req(`Bearer ${TOKEN}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
  });
});
