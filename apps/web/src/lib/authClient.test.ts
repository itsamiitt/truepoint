// authClient.test.ts — pure-helper tests for recoveryActionFor (the DOM-free recovery classifier).
// We assert ONLY the pure helper here: no React component, no sessionStorage, no browser globals.
import { describe, expect, it } from "bun:test";
import { recoveryActionFor } from "./authClient.ts";

describe("recoveryActionFor", () => {
  it("classifies stale/expired/single-use reasons as restart", () => {
    expect(recoveryActionFor("invalid_state")).toBe("restart");
    expect(recoveryActionFor("pkce_mismatch")).toBe("restart");
    expect(recoveryActionFor("code_not_found")).toBe("restart");
  });

  it("classifies an auth-origin outage as retry", () => {
    expect(recoveryActionFor("auth_unavailable")).toBe("retry");
  });

  it("classifies generic/unknown reasons as fail", () => {
    expect(recoveryActionFor("exchange_failed")).toBe("fail");
    expect(recoveryActionFor("ip_mismatch")).toBe("fail");
    expect(recoveryActionFor("origin_mismatch")).toBe("fail");
    expect(recoveryActionFor("switch_failed")).toBe("fail");
    expect(recoveryActionFor("something_unexpected")).toBe("fail");
    expect(recoveryActionFor("")).toBe("fail");
  });
});
