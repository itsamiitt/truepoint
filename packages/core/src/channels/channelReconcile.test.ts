// channelReconcile.test.ts — unit coverage for the PURE S-CH5 drift decider (decideChannelReconcile). IO-free
// (no DB, no crypto): the branch table of 05 §3.4 / §Edge in isolation. The executable end-to-end proof is
// packages/db/test/contactChannels.reconcile.itest.ts. Run: `bun test ./packages/core/src/channels/channelReconcile.test.ts`

import { describe, expect, test } from "bun:test";
import {
  type ChannelReconcileState,
  decideChannelReconcile,
} from "./channelReconcile.ts";

/** A fully-coherent, drift-free state (the decider should never be called on it in prod, but noop is correct). */
const coherent: ChannelReconcileState = {
  hasFlat: true,
  anyLiveChild: true,
  primaryExists: true,
  primaryCoherent: true,
  primaryMatchesFlatValue: true,
  flatValueLiveRowExists: true,
  builtEqualsPrimary: true,
};

const s = (over: Partial<ChannelReconcileState>): ChannelReconcileState => ({ ...coherent, ...over });

describe("decideChannelReconcile — degenerate states (05 §Edge, direction-independent)", () => {
  test("both null ⇒ noop", () => {
    const st = s({ hasFlat: false, anyLiveChild: false, primaryExists: false });
    expect(decideChannelReconcile("flat", st)).toBe("noop");
    expect(decideChannelReconcile("child", st)).toBe("noop");
  });

  test("child primary, no flat ⇒ project flat from child (both directions — non-lossy)", () => {
    const st = s({ hasFlat: false, anyLiveChild: true, primaryExists: true });
    expect(decideChannelReconcile("flat", st)).toBe("project_flat_from_child");
    expect(decideChannelReconcile("child", st)).toBe("project_flat_from_child");
  });

  test("flat present, no live child ⇒ create from flat (both directions)", () => {
    const st = s({
      hasFlat: true,
      anyLiveChild: false,
      primaryExists: false,
      primaryCoherent: false,
      primaryMatchesFlatValue: false,
      flatValueLiveRowExists: false,
      builtEqualsPrimary: false,
    });
    expect(decideChannelReconcile("flat", st)).toBe("create_from_flat");
    expect(decideChannelReconcile("child", st)).toBe("create_from_flat");
  });
});

describe("decideChannelReconcile — flat wins (read gate OFF, dual-write era)", () => {
  test("coherent primary ⇒ noop", () => {
    expect(decideChannelReconcile("flat", coherent)).toBe("noop");
  });

  test("primary holds the flat value but grades/bytes differ ⇒ refresh in place", () => {
    const st = s({ primaryCoherent: false, primaryMatchesFlatValue: true, builtEqualsPrimary: false });
    expect(decideChannelReconcile("flat", st)).toBe("write_primary_from_flat");
  });

  test("the flat value lives on a SECONDARY (the coherence gap) ⇒ swap", () => {
    const st = s({
      primaryCoherent: false,
      primaryMatchesFlatValue: false,
      flatValueLiveRowExists: true,
      builtEqualsPrimary: false,
    });
    expect(decideChannelReconcile("flat", st)).toBe("swap_to_flat");
  });

  test("primary holds a stale value, no live row matches flat ⇒ rewrite primary in place", () => {
    const st = s({
      primaryCoherent: false,
      primaryMatchesFlatValue: false,
      flatValueLiveRowExists: false,
      builtEqualsPrimary: false,
    });
    expect(decideChannelReconcile("flat", st)).toBe("write_primary_from_flat");
  });

  test("primary vacuum (live rows, none primary, none matches flat) ⇒ create from flat", () => {
    const st = s({
      primaryExists: false,
      primaryCoherent: false,
      primaryMatchesFlatValue: false,
      flatValueLiveRowExists: false,
      builtEqualsPrimary: false,
    });
    expect(decideChannelReconcile("flat", st)).toBe("create_from_flat");
  });

  test("primary vacuum but a secondary holds the flat value ⇒ swap (promote it)", () => {
    const st = s({
      primaryExists: false,
      primaryCoherent: false,
      primaryMatchesFlatValue: false,
      flatValueLiveRowExists: true,
      builtEqualsPrimary: false,
    });
    expect(decideChannelReconcile("flat", st)).toBe("swap_to_flat");
  });

  test("non-representable legacy grade phantom (built == primary, raw flat != primary) ⇒ noop, no churn", () => {
    const st = s({ primaryCoherent: false, builtEqualsPrimary: true });
    expect(decideChannelReconcile("flat", st)).toBe("noop");
  });
});

describe("decideChannelReconcile — child wins (read gate ON, post-cutover)", () => {
  test("coherent primary ⇒ noop", () => {
    expect(decideChannelReconcile("child", coherent)).toBe("noop");
  });

  test("primary diverges from flat ⇒ project flat from child (child value wins)", () => {
    const st = s({ primaryCoherent: false });
    expect(decideChannelReconcile("child", st)).toBe("project_flat_from_child");
  });

  test("a non-representable-grade phantom still clears child-wins (flat adopts the sanitized child grade)", () => {
    const st = s({ primaryCoherent: false, builtEqualsPrimary: true });
    expect(decideChannelReconcile("child", st)).toBe("project_flat_from_child");
  });

  test("primary vacuum ⇒ promote oldest, then project flat from it", () => {
    const st = s({ primaryExists: false, primaryCoherent: false });
    expect(decideChannelReconcile("child", st)).toBe("promote_oldest_then_project_flat");
  });
});
