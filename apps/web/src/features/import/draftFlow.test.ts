// draftFlow.test.ts — pins the S-U7 draft-wizard state machine (import-redesign 11 §3 over S-I8). Pure —
// no React, no network (the hook is a thin shell over these rules). The regressions guarded: a deep-link
// must never land on a step the flow hasn't earned (preview needs a saved mapping, confirm needs a seen
// projection — G-IMP-1's confirm-what-happens posture); RESUME must never re-enter the mapping grid (no
// read DTO restores headers/mapping — the doc-16 drift); the server auto-map proposal must never inject
// hidden, un-editable fields; and the gate probe's fallback is the CANARY rule (anything but a clean
// gate-on answer keeps today's client-side one-shot flow).

import { describe, expect, test } from "bun:test";
import type { ImportPreviewSummary } from "@leadwolf/types";
import {
  DRAFT_STEPS,
  canEnterStep,
  clampStep,
  coerceResumeStep,
  draftPathFromProbe,
  filterMappingToMappable,
  parseStepParam,
  previewBlocked,
  previewContinueLabel,
  stepHeading,
} from "./draftFlow.ts";

function summary(over: Partial<ImportPreviewSummary> = {}): ImportPreviewSummary {
  return {
    total: 10,
    valid: 8,
    rejected: 2,
    wouldCreate: 5,
    wouldUpdate: 3,
    duplicateInFile: 0,
    rejectHistogram: {},
    perColumn: [],
    ...over,
  };
}

describe("parseStepParam (the ?step= contract)", () => {
  test("accepts exactly map|preview|confirm", () => {
    expect(parseStepParam("map")).toBe("map");
    expect(parseStepParam("preview")).toBe("preview");
    expect(parseStepParam("confirm")).toBe("confirm");
  });
  test("unknown, empty, and absent values are null (stale deep-links never break the wizard)", () => {
    expect(parseStepParam("upload")).toBeNull();
    expect(parseStepParam("MAP")).toBeNull();
    expect(parseStepParam("")).toBeNull();
    expect(parseStepParam(null)).toBeNull();
    expect(parseStepParam(undefined)).toBeNull();
  });
});

describe("step gating (canEnterStep / clampStep)", () => {
  const nothing = { mappingSaved: false, previewed: false };
  const mapped = { mappingSaved: true, previewed: false };
  const previewed = { mappingSaved: true, previewed: true };

  test("map is always enterable; preview needs a saved mapping; confirm needs a projection", () => {
    expect(canEnterStep("map", nothing)).toBe(true);
    expect(canEnterStep("preview", nothing)).toBe(false);
    expect(canEnterStep("preview", mapped)).toBe(true);
    expect(canEnterStep("confirm", mapped)).toBe(false);
    expect(canEnterStep("confirm", previewed)).toBe(true);
  });

  test("clamp walks a too-deep request back to the deepest earned step", () => {
    expect(clampStep("confirm", nothing)).toBe("map");
    expect(clampStep("confirm", mapped)).toBe("preview");
    expect(clampStep("confirm", previewed)).toBe("confirm");
    expect(clampStep("preview", nothing)).toBe("map");
  });

  test("every declared step is reachable with full facts (vocabulary stays closed)", () => {
    for (const s of DRAFT_STEPS) {
      expect(canEnterStep(s, previewed)).toBe(true);
      expect(stepHeading(s).length).toBeGreaterThan(0);
    }
  });
});

describe("resume coercion (headers/mapping are not client-restorable)", () => {
  test("?step=map (and no step) coerce to preview on resume", () => {
    expect(coerceResumeStep("map", { mappingSaved: true, previewed: true })).toBe("preview");
    expect(coerceResumeStep(null, { mappingSaved: true, previewed: false })).toBe("preview");
  });
  test("?step=confirm resumes at confirm only once a projection is in hand (cached counts)", () => {
    expect(coerceResumeStep("confirm", { mappingSaved: true, previewed: true })).toBe("confirm");
    expect(coerceResumeStep("confirm", { mappingSaved: true, previewed: false })).toBe("preview");
  });
});

describe("filterMappingToMappable (the server proposal filter)", () => {
  test("keeps only fields the grid renders and drops empty values", () => {
    const filtered = filterMappingToMappable({
      email: "E-mail",
      firstName: "First",
      // salesNavProfileUrl is a canonical field with NO wizard control — must not ride along hidden.
      salesNavProfileUrl: "Profile",
    });
    expect(filtered).toEqual({ email: "E-mail", firstName: "First" });
  });
  test("empty proposal stays empty", () => {
    expect(filterMappingToMappable({})).toEqual({});
  });
});

describe("preview step affordances", () => {
  test("continue label is honest about skips", () => {
    expect(previewContinueLabel(summary({ rejected: 0 }))).toBe("Continue");
    expect(previewContinueLabel(summary({ rejected: 1 }))).toBe("Continue — 1 row will be skipped");
    expect(previewContinueLabel(summary({ rejected: 2 }))).toBe("Continue — 2 rows will be skipped");
    expect(previewContinueLabel(null)).toBe("Continue");
  });
  test("a 100%-rejected projection blocks; an empty or partly-valid one does not", () => {
    expect(previewBlocked(summary({ total: 5, valid: 0, rejected: 5 }))).toBe(true);
    expect(previewBlocked(summary({ total: 5, valid: 1, rejected: 4 }))).toBe(false);
    expect(previewBlocked(summary({ total: 0, valid: 0, rejected: 0 }))).toBe(false);
    expect(previewBlocked(null)).toBe(false);
  });
});

describe("the gate-off fallback (the canary rule)", () => {
  test("only a clean gate-on probe engages the draft path — 404/not-enabled AND probe errors fall back", () => {
    expect(draftPathFromProbe("enabled")).toBe(true);
    expect(draftPathFromProbe("not-enabled")).toBe(false);
    expect(draftPathFromProbe("error")).toBe(false);
  });
});
