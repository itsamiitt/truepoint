// format.test.ts — pins the System health area's pure helpers: service status → badge tone, and the service
// label (API is special-cased; others are capitalized).

import { describe, expect, it } from "bun:test";
import { serviceLabel, serviceTone } from "./format.ts";

describe("serviceTone", () => {
  it("maps service statuses to the right tone", () => {
    expect(serviceTone("up")).toBe("success");
    expect(serviceTone("degraded")).toBe("warning");
    expect(serviceTone("down")).toBe("danger");
    expect(serviceTone("unknown")).toBe("muted");
  });
});

describe("serviceLabel", () => {
  it("uppercases API and capitalizes others", () => {
    expect(serviceLabel("api")).toBe("API");
    expect(serviceLabel("database")).toBe("Database");
    expect(serviceLabel("redis")).toBe("Redis");
  });
});
