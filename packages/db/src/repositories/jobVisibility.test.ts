// jobVisibility.test.ts — pure unit tests for THE job-visibility predicate (import-redesign 10 §4) + the
// T-V8 signature guard's runtime half: the unpredicated job-read names must stay EXTINCT on every job
// repository (10 §4.2 rule 1 — rename-don't-overload; the compile-time half is the required JobViewer
// parameter itself, enforced by typecheck). No DB: the predicate builds SQL, it doesn't run it.

import { describe, expect, it } from "bun:test";
import type { JobViewer } from "@leadwolf/types";
import { importJobs } from "../schema/importJobs.ts";
import { enrichmentJobRepository } from "./enrichmentJobRepository.ts";
import { importJobRepository } from "./importJobRepository.ts";
import { creatorVisibility, jobVisibility } from "./jobVisibility.ts";
import { revealJobRepository } from "./revealJobRepository.ts";
import { sourceImportRepository } from "./sourceImportRepository.ts";

const cols = {
  createdByUserId: importJobs.createdByUserId,
  sharedWithWorkspace: importJobs.sharedWithWorkspace,
};

const viewer = (over: Partial<JobViewer>): JobViewer => ({
  userId: "11111111-1111-1111-1111-111111111111",
  role: "member",
  scoped: true,
  ...over,
});

describe("jobVisibility predicate (10 §2.1 matrix)", () => {
  it("short-circuits to workspace-wide while the dual gate is off (T-V4 byte-identity)", () => {
    expect(jobVisibility(viewer({ scoped: false }), cols)).toBeUndefined();
    expect(jobVisibility(viewer({ scoped: false, role: "viewer" }), cols)).toBeUndefined();
    expect(creatorVisibility(viewer({ scoped: false }), importJobs.createdByUserId)).toBeUndefined();
  });

  it("elevated roles see all rows (no FURTHER narrowing — RLS walls the workspace)", () => {
    expect(jobVisibility(viewer({ role: "owner" }), cols)).toBeUndefined();
    expect(jobVisibility(viewer({ role: "admin" }), cols)).toBeUndefined();
    expect(creatorVisibility(viewer({ role: "admin" }), importJobs.createdByUserId)).toBeUndefined();
  });

  it("members and viewers get the creator-or-shared narrowing", () => {
    expect(jobVisibility(viewer({}), cols)).toBeDefined();
    expect(jobVisibility(viewer({ role: "viewer" }), cols)).toBeDefined();
    expect(creatorVisibility(viewer({}), importJobs.createdByUserId)).toBeDefined();
  });
});

describe("T-V8 signature guard — the unpredicated job-read names stay extinct (10 §4.2 rule 1)", () => {
  it("no job repository exports listJobsByWorkspace", () => {
    expect("listJobsByWorkspace" in importJobRepository).toBe(false);
    expect("listJobsByWorkspace" in revealJobRepository).toBe(false);
    expect("listJobsByWorkspace" in enrichmentJobRepository).toBe(false);
  });

  it("the viewer-taking reads and the explicitly-named system reads exist instead", () => {
    expect(typeof importJobRepository.listJobs).toBe("function");
    expect(typeof importJobRepository.getJob).toBe("function");
    expect(typeof importJobRepository.getJobSystem).toBe("function");
    expect(typeof revealJobRepository.listJobs).toBe("function");
    expect(typeof revealJobRepository.getJob).toBe("function");
    expect(typeof revealJobRepository.getJobSystem).toBe("function");
    expect(typeof enrichmentJobRepository.listJobs).toBe("function");
    expect(typeof enrichmentJobRepository.getJob).toBe("function");
    expect(typeof enrichmentJobRepository.getJobSystem).toBe("function");
    expect(typeof sourceImportRepository.recentBatches).toBe("function");
    // recentBatches takes (scope, viewer, limit?, tx?) — the viewer is positionally REQUIRED.
    expect(sourceImportRepository.recentBatches.length).toBeGreaterThanOrEqual(2);
  });
});
