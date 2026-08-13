// enrichContactV2.test.ts — the PURE D8 ordering resolution (0111): per-run override → workspace
// per-field priority → engine default (trust ÷ cost), explicit lists as PREFIXES, disabled subtraction,
// unknown-name tolerance. The tx-split orchestration itself is proven by the db itest
// (enrichWaterfallV2.itest.ts) — this file stays hermetic.

import { describe, expect, test } from "bun:test";
import type { ProviderPriority } from "@leadwolf/types";
import { resolveProviderOrder } from "./enrichContactV2.ts";
import type { EnrichRequest, EnrichmentProvider } from "./providerPort.ts";

const REQUEST: EnrichRequest = {
  workspaceId: "11111111-1111-1111-1111-111111111111",
  entityType: "contact",
  fields: ["email", "phone"],
  subject: { companyDomain: "acme.com" },
};

function provider(name: string, trust: number, cost: number): EnrichmentProvider {
  return {
    name,
    capabilities: ["contact.email", "contact.phone", "contact.profile"],
    trust,
    estimateCostMicros: () => cost,
    enrich: () => Promise.reject(new Error("never called in ordering tests")),
  };
}

// Real provider ids (the prefs schema is enum-typed). Default score = trust ÷ cost:
// clearbit (0.7/20k=3.5e-5) > apollo (0.8/30k≈2.7e-5) > zoominfo (0.85/60k≈1.4e-5).
const PROVIDERS = [
  provider("apollo", 0.8, 30_000),
  provider("clearbit", 0.7, 20_000),
  provider("zoominfo", 0.85, 60_000),
];

const NO_PREFS: ProviderPriority = { version: 1, email: [], phone: [], disabled: [] };

function order(
  field: "email" | "phone",
  opts?: {
    runOverride?: string[];
    priority?: ProviderPriority;
    configDisabled?: Set<string>;
  },
) {
  return resolveProviderOrder({
    providers: PROVIDERS,
    request: REQUEST,
    field,
    runOverride: opts?.runOverride,
    priority: opts?.priority ?? NO_PREFS,
    configDisabled: opts?.configDisabled ?? new Set(),
  });
}

describe("resolveProviderOrder (D8)", () => {
  test("no prefs → engine default: trust ÷ cost descending", () => {
    expect(order("email")).toEqual(["clearbit", "apollo", "zoominfo"]);
  });

  test("workspace per-field priority wins, as a PREFIX — omitted providers still cascade after", () => {
    const priority: ProviderPriority = { version: 1, email: ["zoominfo"], phone: [], disabled: [] };
    expect(order("email", { priority })).toEqual(["zoominfo", "clearbit", "apollo"]);
    // phone has no saved order → engine default untouched.
    expect(order("phone", { priority })).toEqual(["clearbit", "apollo", "zoominfo"]);
  });

  test("email order and phone order are INDEPENDENT", () => {
    const priority: ProviderPriority = {
      version: 1,
      email: ["apollo", "zoominfo"],
      phone: ["zoominfo"],
      disabled: [],
    };
    expect(order("email", { priority })).toEqual(["apollo", "zoominfo", "clearbit"]);
    expect(order("phone", { priority })).toEqual(["zoominfo", "clearbit", "apollo"]);
  });

  test("a per-RUN override beats the workspace priority", () => {
    const priority: ProviderPriority = { version: 1, email: ["zoominfo"], phone: [], disabled: [] };
    expect(order("email", { priority, runOverride: ["apollo"] })).toEqual([
      "apollo",
      "clearbit",
      "zoominfo",
    ]);
  });

  test("disabled (workspace) and config-disabled are subtracted LAST — even out of an explicit list", () => {
    const priority: ProviderPriority = {
      version: 1,
      email: ["zoominfo", "apollo"],
      phone: [],
      disabled: ["zoominfo"],
    };
    expect(order("email", { priority })).toEqual(["apollo", "clearbit"]);
    expect(order("email", { priority, configDisabled: new Set(["clearbit"]) })).toEqual(["apollo"]);
  });

  test("unknown names in stored prefs are ignored, never break the run", () => {
    const priority: ProviderPriority = {
      version: 1,
      email: ["ghost", "apollo"] as unknown as ProviderPriority["email"],
      phone: [],
      disabled: [],
    };
    expect(order("email", { priority })).toEqual(["apollo", "clearbit", "zoominfo"]);
  });

  test("profile fields (jobTitle et al.) have no per-field pref — engine default", () => {
    const priority: ProviderPriority = {
      version: 1,
      email: ["zoominfo"],
      phone: ["apollo"],
      disabled: [],
    };
    const out = resolveProviderOrder({
      providers: PROVIDERS,
      request: REQUEST,
      field: "jobTitle",
      priority,
      configDisabled: new Set(),
    });
    expect(out).toEqual(["clearbit", "apollo", "zoominfo"]);
  });
});
