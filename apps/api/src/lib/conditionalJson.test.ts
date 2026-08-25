// conditionalJson.test.ts — the 304 contract.
//
// A wrong 304 is the worst outcome available here: the client keeps a stale body, believes it is current, and
// nothing errors anywhere. So the cases below lean on "when must it NOT 304" at least as hard as the happy
// path.

import { describe, expect, test } from "bun:test";
import { etagFor, ifNoneMatchSatisfied } from "./conditionalJson.ts";

describe("etagFor", () => {
  test("identical bodies produce identical tags, different bodies do not", () => {
    const a = JSON.stringify({ status: "running", rowsCreated: 10 });
    const b = JSON.stringify({ status: "running", rowsCreated: 11 });
    expect(etagFor(a)).toBe(etagFor(a));
    expect(etagFor(a)).not.toBe(etagFor(b));
  });

  test("a one-field change anywhere in the body changes the tag", () => {
    // The reason the hash is over the whole body rather than a chosen fingerprint: a field nobody thought to
    // include must still invalidate, or a client pins to a stale body with no error.
    const base = { status: "running", counts: { created: 1 }, stage: "process" };
    const moved = { status: "running", counts: { created: 1 }, stage: "finalize" };
    expect(etagFor(JSON.stringify(base))).not.toBe(etagFor(JSON.stringify(moved)));
  });

  test("the tag is quoted — an unquoted entity-tag is malformed", () => {
    const tag = etagFor("{}");
    expect(tag.startsWith('"')).toBe(true);
    expect(tag.endsWith('"')).toBe(true);
  });
});

describe("ifNoneMatchSatisfied", () => {
  const etag = etagFor(JSON.stringify({ status: "running" }));

  test("no header ⇒ never satisfied", () => {
    expect(ifNoneMatchSatisfied(undefined, etag)).toBe(false);
    expect(ifNoneMatchSatisfied("", etag)).toBe(false);
  });

  test("exact match ⇒ satisfied", () => {
    expect(ifNoneMatchSatisfied(etag, etag)).toBe(true);
  });

  test("a DIFFERENT tag ⇒ not satisfied", () => {
    expect(ifNoneMatchSatisfied(etagFor("{}"), etag)).toBe(false);
  });

  test("the list form is honoured — a client may hold several validators", () => {
    expect(ifNoneMatchSatisfied(`"other", ${etag}`, etag)).toBe(true);
    expect(ifNoneMatchSatisfied(`"other", "another"`, etag)).toBe(false);
  });

  test("`*` matches any existing entity, per the spec", () => {
    expect(ifNoneMatchSatisfied("*", etag)).toBe(true);
  });

  test("a weakened tag from an intermediary still matches", () => {
    // RFC 9110 §8.8.3.2: If-None-Match uses WEAK comparison, so `W/"x"` and `"x"` are the same entity here.
    // Treating them as different would send a full body on every poll behind a proxy that weakens tags — the
    // saving would silently disappear in exactly the deployments that need it.
    expect(ifNoneMatchSatisfied(`W/${etag}`, etag)).toBe(true);
  });

  test("a prefix of a real tag does NOT match", () => {
    // Guards against a substring-style comparison creeping in later. A validator that matches loosely is a
    // stale-content bug wearing a performance win's clothing.
    const partial = etag.slice(0, etag.length - 3);
    expect(ifNoneMatchSatisfied(`${partial}"`, etag)).toBe(false);
  });
});
