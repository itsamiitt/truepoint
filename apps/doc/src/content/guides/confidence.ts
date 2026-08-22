// confidence.ts — how to read field_provenance. This is the page the whole product is supposed to justify,
// so it is written to be useful to a sceptic: it says what each class means, and it says plainly which parts
// of the model are shipped and which are not.
//
// Outcomes served: S-10 (record confidence and verification recency visible at a glance) and A-01 (every
// stored field has provenance and a lawful basis). Publishing the vocabulary is what makes the in-product
// badge legible to someone who has not logged in.

import type { Guide } from "../types.ts";

export const CONFIDENCE: Guide = {
  slug: "confidence",
  title: "Confidence and provenance",
  summary:
    "What field_provenance contains, what each source class means, and how to decide whether to act on a field.",
  blocks: [
    {
      kind: "p",
      text: "Person and company profile fields are returned with an entry in field_provenance describing where the value came from, when it was last seen, and how many independent sources agree. A record without that context is a guess presented as a fact, and this API will not hand you one.",
    },
    {
      kind: "note",
      tone: "warning",
      text: "No callable endpoint returns field_provenance yet. Both endpoints that carry it — person enrichment and search — are planned, not built, and their pages say so. What follows is the published model you can design against, not a description of bytes you can fetch today. The one freshness signal a live endpoint does return is company.last_updated on enrichment.",
    },
    {
      kind: "code",
      language: "json",
      source: `"field_provenance": {
  "title":      { "sources": 3, "class": "corroborated", "last_seen": "2026-08-14" },
  "work_email": { "sources": 2, "class": "verified",     "last_seen": "2026-08-19" },
  "headcount":  { "sources": 1, "class": "single-source", "last_seen": "2026-02-03" }
}`,
    },
    { kind: "h2", text: "Source classes" },
    {
      kind: "table",
      headers: ["Class", "What it means", "How to treat it"],
      rows: [
        [
          "verified",
          "The value passed an active check against the thing itself — for an address, a deliverability check rather than a pattern guess.",
          "The strongest class. Act on it.",
        ],
        [
          "corroborated",
          "Two or more independent sources produced the same value.",
          "Strong. Independence is the point: three copies of one upstream feed is still one source.",
        ],
        [
          "single-source",
          "One source, no agreement, no active check.",
          "Usable, but check last_seen before acting. This is where staleness hides.",
        ],
        [
          "inferred",
          "Derived from a pattern rather than observed — an address built from a company's known format, for example.",
          "A hypothesis. Never present it to a person as a verified fact.",
        ],
      ],
    },
    { kind: "h2", text: "What the store holds, and why this is a projection of it" },
    {
      kind: "p",
      text: "Internally a field carries a source label, a confidence between 0 and 1, an observed-at and a last-verified-at timestamp, and a flag marking a human correction that no later import may overwrite. The class above is a projection of that, computed at the point the API answers — not a value sitting in a column.",
    },
    {
      kind: "p",
      text: "The projection exists for a reason rather than as a convenience. The stored source label names the specific upstream a value came from, and publishing that per field would disclose our supplier arrangements one record at a time; it is also the same category of leak that stops us naming the contributing workspace behind any value. So what leaves the system is the property you can act on — how strongly a value is attested — and not the identity of who attested it.",
    },
    {
      kind: "note",
      tone: "info",
      text: "The exact shape of that projection is an open decision, recorded as C5 in ADR-0048 rather than settled quietly here. If it changes before person enrichment ships, it changes on this page and in the changelog on the same day.",
    },
    { kind: "h2", text: "Recency matters more than the class for some fields" },
    {
      kind: "p",
      text: "Different fields go stale at different speeds. A job title is worth roughly what it was worth a month ago and much less than that a year on, because people change roles. A company's registered country effectively never changes. Read last_seen against the field, not against a single global threshold.",
    },
    {
      kind: "note",
      tone: "info",
      text: "Automatic per-field decay — a confidence score that falls on its own as a value ages without fresh evidence — is designed but not yet shipped. Until it is, last_seen is the honest signal and the class does not decay by itself. We would rather say that here than let you infer a freshness guarantee we are not yet making.",
    },
    { kind: "h2", text: "A rule of thumb" },
    {
      kind: "list",
      items: [
        "Verified or corroborated, seen in the last 90 days — act on it.",
        "Single-source, seen in the last 90 days — act on it where a wrong answer is cheap; verify first where it is not.",
        "Anything older than a year — treat as a lead to re-check, not as a fact.",
        "Inferred — never send an email to an inferred address without verifying it first. That is precisely the path that produces bounces.",
      ],
    },
    { kind: "h2", text: "Why we publish this at all" },
    {
      kind: "p",
      text: "Two reasons, and neither is marketing. A buyer who cannot distinguish our fresh, corroborated data from a competitor's stale bulk file has no reason to prefer either, so the distinction has to be legible from outside. And provenance is the first question a regulator asks: a field we cannot source is a field we should not be storing.",
    },
  ],
};
