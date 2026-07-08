// metricsRoute.test.ts — the internal /metrics scrape endpoint. Drives the REAL app through app.request() with
// @leadwolf/config spread from the real (preload-seeded) module and only env.METRICS_TOKEN overridden per case
// (a Proxy so a per-test reassignment is read live inside the handler). Proves the security posture: OFF by
// default (404), invisible to a wrong/absent token (404 — deliberately not 401, don't advertise), and only the
// exact Bearer secret renders the Prometheus text. No DB/JWT (@leadwolf/db is lazy).

import { describe, expect, it, mock } from "bun:test";
import * as realConfig from "@leadwolf/config";

let metricsToken: string | undefined;
mock.module("@leadwolf/config", () => ({
  ...realConfig,
  env: new Proxy(realConfig.env, {
    get: (target, prop) => (prop === "METRICS_TOKEN" ? metricsToken : Reflect.get(target, prop)),
  }),
}));

const { app } = await import("./app.ts");
const TOKEN = "test-metrics-token-0123456789";

describe("GET /metrics", () => {
  it("404s when METRICS_TOKEN is unset — the endpoint is off/invisible by default", async () => {
    metricsToken = undefined;
    const res = await app.request("/metrics", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(404);
  });

  it("404s on a wrong or absent token when enabled — never advertises its existence", async () => {
    metricsToken = TOKEN;
    expect((await app.request("/metrics")).status).toBe(404);
    expect(
      (await app.request("/metrics", { headers: { authorization: "Bearer wrong" } })).status,
    ).toBe(404);
  });

  it("renders Prometheus text for the exact Bearer secret", async () => {
    metricsToken = TOKEN;
    const res = await app.request("/metrics", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
  });
});
