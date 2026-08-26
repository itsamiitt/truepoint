// versioning.ts — what "v1" promises, what counts as a breaking change, and how you find out about one.
//
// This page exists because the rest of the site kept implying a policy nobody had written down. Every path
// carries `/v1`, every endpoint carries an availability badge, the changelog promises to record contract
// changes, and the OpenAPI document stamps `x-availability` on each operation — four mechanisms pointing at a
// policy that existed only as an intention. An integrator deciding whether to build on this API is deciding
// how much notice they will get before it moves, and "we have a changelog" is not an answer to that.
//
// What is published here is the MECHANISM, which is a technical fact we control and can state honestly: what
// changes we consider additive, what we consider breaking, and every channel a change is announced through.
//
// What is deliberately NOT published is a notice period. A number of days before a breaking change is a
// commercial commitment — it belongs in an agreement and it needs an operator decision (CLAUDE.md rule 1:
// work serving no ratified outcome gets flagged, not invented). Publishing "90 days" here because it sounds
// standard would be exactly the kind of unbacked claim the rest of this site is careful to avoid, and
// versioning.test-adjacent assertions in content.test.ts keep it out.

import type { Guide } from "../types.ts";

export const VERSIONING: Guide = {
  slug: "versioning",
  title: "Versioning and change policy",
  summary:
    "What v1 covers, which changes are additive and which are breaking, and every channel a change is announced through.",
  blocks: [
    {
      kind: "p",
      text: "The version is in the path. Every endpoint lives under /api/v1/public, v1 is the only version, and a URL that worked will keep meaning the same thing for as long as v1 is current. A second version, if it ever exists, will be a second path rather than a change of behaviour under the first.",
    },
    { kind: "h2", text: "What we can change without warning" },
    {
      kind: "p",
      text: "These are additive: existing calls keep working, existing fields keep their meaning, and a client that ignores what it does not recognise is unaffected. Write your integration so that they are, and most of our changes stop being your problem.",
    },
    {
      kind: "list",
      items: [
        "Adding a new field to a response. Parse permissively — an unknown field is not an error.",
        "Adding a new optional parameter, with the existing default unchanged.",
        "Adding a new endpoint, or a new value to a set we already describe as open-ended.",
        "Adding a new error code for a condition that previously fell under a broader one. Branch on the codes you handle and treat the rest as their status class.",
        "Making validation more permissive — accepting an input we used to reject.",
      ],
    },
    { kind: "h2", text: "What counts as breaking" },
    {
      kind: "p",
      text: "These change the meaning of a call that already works, so they cannot land quietly on a version that is current.",
    },
    {
      kind: "list",
      items: [
        "Removing or renaming a response field, or changing its type — including making a field that was always present nullable.",
        "Removing an endpoint, or changing the status code a condition answers with.",
        "Adding a required parameter, or tightening validation so a previously accepted input now fails.",
        "Changing what a credit buys: charging for a call that was free, or charging more for the same result.",
        "Changing the meaning of a field while keeping its name — the worst kind, because nothing on your side errors.",
      ],
    },
    {
      kind: "note",
      tone: "warning",
      text: "The two callable company endpoints are marked beta, and that badge is doing real work: while an endpoint is beta its contract can still change, including in the breaking ways listed above. When it goes generally available, that stops being true and the badge changes on its page.",
    },
    { kind: "h2", text: "How you find out" },
    {
      kind: "p",
      text: "Four channels, and they are generated from the same source rather than maintained by hand, so a change cannot reach one and miss another.",
    },
    {
      kind: "list",
      items: [
        "The changelog records every contract, price and sourcing change on the day it happens.",
        "The Atom feed at /changelog.xml carries the same entries — subscribe rather than remembering to check, because nobody polls a documentation page.",
        "Every endpoint page shows its current availability, and every reference page is generated from the same typed contract the API is described by.",
        "The OpenAPI document stamps x-availability on each operation, so a build step can assert on it without reading a page.",
      ],
    },
    {
      kind: "note",
      tone: "info",
      text: "One thing is not published here: how much notice you get before a breaking change on a generally available endpoint. That is a commercial commitment rather than a technical fact, it belongs in an agreement, and inventing a number on a documentation page would make it look decided when it is not. If you need that commitment in writing, ask us for it — and if you already have an agreement with us, the terms in it are what bind.",
    },
    { kind: "h2", text: "Deprecation, when it happens" },
    {
      kind: "p",
      text: "A deprecated endpoint keeps working. Its page says it is deprecated and what replaces it, the changelog entry says the same, and the OpenAPI document stops listing it once it is no longer something new integrations should build on. Nothing disappears from under a running integration without that sequence happening first, in public.",
    },
  ],
};
