// feed.ts — the changelog as an Atom feed.
//
// The changelog exists because a vendor who changes a contract quietly is a vendor you cannot build on. That
// promise is only worth something if a reader can find out WITHOUT remembering to visit — nobody polls a
// documentation page, so a subscribable feed is what turns "we publish our changes" into "you will know".
//
// Atom rather than RSS: it requires a stable id per entry and an explicit updated timestamp, which is exactly
// the discipline a contract log needs, and every reader that speaks RSS speaks Atom.
//
// Generated from the same CHANGELOG the page renders, so the feed cannot lag the site.

import { CHANGELOG } from "./changelog.ts";
import { SITE_ORIGIN } from "./site.ts";
import type { ChangelogEntry } from "./types.ts";

export const FEED_PATH = "/changelog.xml";

/** Escape the five XML metacharacters. Titles and bodies are our own prose, but prose acquires an ampersand
 *  eventually, and a feed that fails to parse fails silently in someone else's reader.
 *
 *  Exported for its test: today's entries contain none of these characters, so asserting on the rendered
 *  feed would pass whether or not the escaping worked. */
export function xml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Newest first, and stable: entries carry a date, and the file's own order is not meaningful. */
export function sortedEntries(): readonly ChangelogEntry[] {
  return [...CHANGELOG].sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * A tag: URI per entry (RFC 4151).
 *
 * A permalink would be the obvious id, but the changelog is one page rather than a page per entry, so every
 * link would be identical and readers would collapse the entries into one. The tag URI is derived from the
 * date and the title, so it is stable across rebuilds and unique per entry — which is what a reader uses to
 * decide whether it has already shown something.
 */
export function entryId(entry: ChangelogEntry): string {
  const slug = entry.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `tag:doc.truepoint.in,${entry.date}:${slug}`;
}

/** A date-only entry becomes midnight UTC — stated explicitly rather than left to the runtime's timezone. */
function timestamp(date: string): string {
  return `${date}T00:00:00Z`;
}

/**
 * Build the Atom document.
 *
 * Deterministic: the feed's own `updated` is the newest entry's date, NOT the build time. A feed stamped with
 * the current clock changes on every deploy, so a reader that polls it sees an update whenever we redeploy
 * the site — teaching them the changelog cries wolf. This one changes only when the log does.
 */
export function buildFeed(): string {
  const entries = sortedEntries();
  const updated = timestamp(entries[0]?.date ?? "1970-01-01");

  const lines: string[] = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    "  <title>TruePoint Data API — changelog</title>",
    `  <subtitle>${xml("Contract, price and sourcing changes. Published when they happen, not when they are announced.")}</subtitle>`,
    `  <id>tag:doc.truepoint.in,2026:changelog</id>`,
    `  <updated>${updated}</updated>`,
    `  <link rel="alternate" type="text/html" href="${SITE_ORIGIN}/changelog"/>`,
    `  <link rel="self" type="application/atom+xml" href="${SITE_ORIGIN}${FEED_PATH}"/>`,
    "  <author><name>TruePoint</name></author>",
  ];

  for (const entry of entries) {
    lines.push(
      "  <entry>",
      `    <title>${xml(entry.title)}</title>`,
      `    <id>${xml(entryId(entry))}</id>`,
      `    <updated>${timestamp(entry.date)}</updated>`,
      `    <link rel="alternate" type="text/html" href="${SITE_ORIGIN}/changelog"/>`,
      `    <content type="text">${xml(entry.body)}</content>`,
      "  </entry>",
    );
  }

  lines.push("</feed>", "");
  return lines.join("\n");
}
