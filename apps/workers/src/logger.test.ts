// logger.test.ts — proves the structured logger emits exactly one parseable JSON line per call carrying
// ts/level/msg plus arbitrary fields, and routes errors to stderr.

import { expect, test } from "bun:test";
import { log } from "./logger.ts";

test("log.info emits one parseable JSON line with ts/level/msg + fields", () => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (l?: unknown) => {
    lines.push(String(l));
  };
  try {
    log.info("hello", { queue: "imports", jobId: "1" });
  } finally {
    console.log = orig;
  }
  expect(lines).toHaveLength(1);
  const o = JSON.parse(lines[0]!) as Record<string, unknown>;
  expect(o.level).toBe("info");
  expect(o.msg).toBe("hello");
  expect(o.queue).toBe("imports");
  expect(o.jobId).toBe("1");
  expect(typeof o.ts).toBe("string");
});

test("log.error routes to stderr", () => {
  const errs: string[] = [];
  const orig = console.error;
  console.error = (l?: unknown) => {
    errs.push(String(l));
  };
  try {
    log.error("boom", { queue: "scoring" });
  } finally {
    console.error = orig;
  }
  expect(errs).toHaveLength(1);
  expect((JSON.parse(errs[0]!) as { level: string }).level).toBe("error");
});
