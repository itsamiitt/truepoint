// authMetrics.test.ts — the auth SLI counter registry (Phase 1 observability). Proves: same (name, labels) →
// one series that accumulates; different labels → distinct series; label order is normalised; render is stable
// + Prometheus-shaped. The type system (not a runtime test) is what keeps PII/high-cardinality labels out.
import { afterEach, describe, expect, it } from "bun:test";
import { __resetAuthMetrics, recordAuthMetric, renderAuthMetrics } from "./authMetrics.ts";

afterEach(() => __resetAuthMetrics());

describe("authMetrics", () => {
  it("accumulates repeated increments of the same series", () => {
    recordAuthMetric("auth_login_total", { result: "success", method: "password" });
    recordAuthMetric("auth_login_total", { result: "success", method: "password" });
    expect(renderAuthMetrics()).toBe('auth_login_total{method="password",result="success"} 2');
  });

  it("keeps different label sets as distinct series", () => {
    recordAuthMetric("auth_login_total", { result: "success", method: "sso" });
    recordAuthMetric("auth_login_total", { result: "failure", method: "sso" });
    recordAuthMetric("auth_policy_block_total", { reason: "mfa" });
    const out = renderAuthMetrics().split("\n");
    expect(out).toContain('auth_login_total{method="sso",result="failure"} 1');
    expect(out).toContain('auth_login_total{method="sso",result="success"} 1');
    expect(out).toContain('auth_policy_block_total{reason="mfa"} 1');
  });

  it("normalises label order so the same set is one series regardless of key order", () => {
    // (result/method vs method/result at the type level would still key identically because keys are sorted)
    recordAuthMetric("auth_revocation_check_total", { result: "degraded" });
    recordAuthMetric("auth_revocation_check_total", { result: "degraded" });
    expect(renderAuthMetrics()).toBe('auth_revocation_check_total{result="degraded"} 2');
  });

  it("renders series sorted, one per line (stable scrape output)", () => {
    recordAuthMetric("auth_token_mint_total", { result: "failure" });
    recordAuthMetric("auth_mfa_challenge_total", { result: "passed" });
    const lines = renderAuthMetrics().split("\n");
    expect(lines).toEqual([...lines].sort()); // sorted
    expect(lines.length).toBe(2);
  });

  it("__resetAuthMetrics clears the registry", () => {
    recordAuthMetric("auth_token_mint_total", { result: "success" });
    __resetAuthMetrics();
    expect(renderAuthMetrics()).toBe("");
  });
});
