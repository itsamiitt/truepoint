// guideSections.test.ts — the fold that pairs each guide section with its samples.
//
// Worth testing because it is the one place on this site where LAYOUT reads content: get the fold wrong and a
// code sample lands under the wrong heading, which reads as documentation error rather than as a CSS bug.
// The invariant that matters most is the last one — every block that went in comes out exactly once.

import { describe, expect, test } from "bun:test";
import { GUIDES, QUICKSTART } from "../../content/guides/index.ts";
import type { Block } from "../../content/types.ts";
import { toSections } from "./guideSections.ts";

const H2 = (text: string): Block => ({ kind: "h2", text });
const P = (text: string): Block => ({ kind: "p", text });
const CODE = (source: string): Block => ({ kind: "code", language: "cURL", source });

describe("sectioning", () => {
  test("blocks before the first heading form their own lead section", () => {
    const sections = toSections([P("lede"), H2("First"), P("body")]);
    expect(sections).toHaveLength(2);
    expect(sections[0]?.heading).toBeUndefined();
    expect(sections[1]?.heading).toBe("First");
  });

  test("a guide opening on a heading produces no empty section above it", () => {
    const sections = toSections([H2("First"), P("body")]);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.heading).toBe("First");
  });

  test("code goes to the sample column, everything else stays in the reading column", () => {
    const [section] = toSections([H2("Auth"), P("before"), CODE("curl"), P("after")]);
    expect(section?.samples.map((sample) => sample.source)).toEqual(["curl"]);
    expect(section?.prose.map((block) => block.kind)).toEqual(["h2", "p", "p"]);
  });

  test("the heading stays in the reading column, not on the pair", () => {
    const [section] = toSections([H2("Auth"), CODE("curl")]);
    expect(section?.prose[0]).toEqual(H2("Auth"));
  });

  test("a sample belongs to the heading above it, never the one below", () => {
    const sections = toSections([H2("A"), CODE("first"), H2("B"), CODE("second")]);
    expect(sections[0]?.samples.map((sample) => sample.source)).toEqual(["first"]);
    expect(sections[1]?.samples.map((sample) => sample.source)).toEqual(["second"]);
  });

  test("several samples under one heading all stay there, in source order", () => {
    const [section] = toSections([H2("Errors"), CODE("one"), P("mid"), CODE("two")]);
    expect(section?.samples.map((sample) => sample.source)).toEqual(["one", "two"]);
  });

  test("an empty guide folds to nothing rather than to one empty section", () => {
    expect(toSections([])).toEqual([]);
  });
});

describe("no block is lost or duplicated on any real guide", () => {
  for (const guide of [QUICKSTART, ...GUIDES]) {
    test(`${guide.slug} round-trips every block exactly once`, () => {
      const out = toSections(guide.blocks).flatMap((section) => [
        ...section.prose,
        ...section.samples,
      ]);
      expect(out).toHaveLength(guide.blocks.length);
      // Set-equal rather than order-equal: the fold deliberately reorders code out of the reading column.
      for (const block of guide.blocks) expect(out).toContain(block);
    });
  }
});
