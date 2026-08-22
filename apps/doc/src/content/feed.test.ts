// feed.test.ts — the Atom feed, checked for the properties a reader actually depends on.
//
// A broken feed fails in someone else's software, silently, and we never hear about it. So the assertions
// here are the ones a reader would notice: it parses, every entry has a unique stable id, and the feed's
// timestamp tracks the log rather than the build.

import { describe, expect, test } from "bun:test";
import { CHANGELOG } from "./changelog.ts";
import { FEED_PATH, buildFeed, entryId, sortedEntries, xml } from "./feed.ts";

const FEED = buildFeed();

describe("it is a well-formed Atom document", () => {
  test("declares XML and the Atom namespace, and closes", () => {
    expect(FEED.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
    expect(FEED).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(FEED.trimEnd().endsWith("</feed>")).toBe(true);
  });

  test("every tag opened is closed", () => {
    for (const tag of ["feed", "entry", "title", "id", "updated", "content"]) {
      const open = (FEED.match(new RegExp(`<${tag}(?:\\s[^>]*)?>`, "g")) ?? []).length;
      const close = (FEED.match(new RegExp(`</${tag}>`, "g")) ?? []).length;
      expect(open).toBe(close);
    }
  });

  test("carries a self link at the served path and an alternate to the page", () => {
    expect(FEED).toContain(`href="https://doc.truepoint.in${FEED_PATH}"`);
    expect(FEED).toContain('href="https://doc.truepoint.in/changelog"');
  });
});

describe("every changelog entry is in it, exactly once", () => {
  test("entry count matches the log", () => {
    expect((FEED.match(/<entry>/g) ?? []).length).toBe(CHANGELOG.length);
  });

  test("ids are unique and stable across builds", () => {
    const ids = CHANGELOG.map(entryId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(buildFeed()).toBe(FEED);
    for (const id of ids) expect(FEED).toContain(id);
  });

  test("entries are newest first", () => {
    const dates = sortedEntries().map((entry) => entry.date);
    expect([...dates].sort((a, b) => b.localeCompare(a))).toEqual(dates);
  });
});

describe("the feed's timestamp tracks the log, not the deploy", () => {
  test("feed updated equals the newest entry's date", () => {
    const newest = sortedEntries()[0];
    expect(newest).toBeDefined();
    expect(FEED).toContain(`<updated>${(newest as { date: string }).date}T00:00:00Z</updated>`);
  });

  test("no build-time clock leaked in", () => {
    // Anything stamped with today would make every redeploy look like a contract change to a subscriber.
    const stamps = [...FEED.matchAll(/<updated>([^<]+)<\/updated>/g)].map((m) => m[1] ?? "");
    const known = new Set(sortedEntries().map((entry) => `${entry.date}T00:00:00Z`));
    for (const stamp of stamps) expect(known.has(stamp)).toBe(true);
  });
});

describe("XML escaping", () => {
  // Asserted on the escaper directly. Today's entries contain none of these characters, so a test that only
  // inspected the rendered feed would pass whether or not the escaping worked — the failure mode being
  // guarded against is the FIRST entry that contains an ampersand, months from now.
  test("all five metacharacters are replaced", () => {
    expect(xml(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &apos;");
  });

  test("an entry containing markup could not break out of its element", () => {
    const hostile = xml("</content><entry><title>injected</title>");
    expect(hostile).not.toContain("<");
    expect(hostile).not.toContain(">");
  });

  test("ampersands are escaped before the other replacements, not after", () => {
    // The classic ordering bug: escaping `<` first, then `&`, turns `&lt;` into `&amp;lt;`.
    expect(xml("<")).toBe("&lt;");
    expect(xml("&lt;")).toBe("&amp;lt;");
  });
});
