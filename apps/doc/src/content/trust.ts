// trust.ts — the public data ethics and sourcing statement.
//
// This is the page that earns the app its place in the roadmap. Outcome A-01 says every stored field has
// provenance and a lawful basis; A-02 and S-11 say erasure is real and suppression is enforced at every
// egress. None of those are visible from outside the product unless they are written down somewhere a
// regulator, an enterprise buyer, or a person who has found their own name in a database can read without
// logging in. That is this page.
//
// It is deliberately specific about what we do NOT do. Note what is absent: there is no mention of extracting
// data from behind a login on any platform, because CLAUDE.md rule 4 forbids it outright and a sourcing
// statement that leaves room for it is worse than none. The source brief proposes exactly such a supply
// stage (DocappPlan/04 §Source A, conceded in 08 §Risk 2); that conflict is recorded in ADR-0048 §C2 and is
// the operator's to resolve, not this page's to soften.

import type { TrustSection } from "./types.ts";

export const TRUST_SECTIONS: readonly TrustSection[] = [
  {
    id: "sources",
    title: "Where our data comes from",
    blocks: [
      {
        kind: "p",
        text: "Every field we store is tagged with the class of source it came from. A field we cannot attribute does not enter the graph at all — not as an unattributed value, not as a best guess.",
      },
      {
        kind: "list",
        items: [
          "Public web pages: company sites, career pages and public job postings, crawled directly, respecting robots.txt and rate-limited to be a polite visitor.",
          "Public and official registries, filings and announcements.",
          "Licensed data from vendors, under the terms of those licences.",
          "Corrections and confirmations contributed by TruePoint users about records they are already working with — always on an explicit, revocable opt-in, always logged against the contribution.",
          "Verification signals: whether an address we published actually delivered.",
        ],
      },
      {
        kind: "note",
        tone: "info",
        text: "We do not extract data from behind a login on any platform, and we do not operate background collection. The TruePoint browser extension acts only on a page a user has deliberately opened and only when they ask it to.",
      },
    ],
  },
  {
    id: "never",
    title: "What we never collect",
    blocks: [
      {
        kind: "p",
        text: "The scope is business-contact data: who someone is at work, what they do there, and how to reach them there. Everything outside that is out of scope by design rather than by omission.",
      },
      {
        kind: "list",
        items: [
          "No special-category data, ever — health, beliefs, politics, sexuality, biometrics, trade-union membership.",
          "No personal-life data: home addresses, personal social accounts, family details.",
          "No data about minors.",
          "No message content. Where a customer connects a mailbox or a dialer, we take structured outcome metadata — whether a message bounced, whether a call connected — and never the contents.",
        ],
      },
    ],
  },
  {
    id: "your-data",
    title: "If your data is in here",
    blocks: [
      {
        kind: "p",
        text: "You can ask what we hold about you, correct it, or have it removed. You do not need an account, and you do not need to be a customer.",
      },
      {
        kind: "list",
        items: [
          "Write to privacy@truepoint.in from any address, and say which record is yours.",
          "Removal is a suppression, not a hide. A suppressed person stops being returned by search, by enrichment and by exports — there is no flag any customer can set to get them back.",
          "Suppression propagates across the graph and into future deliveries. Files already delivered to a customer are outside our reach, which is why suppression at our egress is the control that matters.",
        ],
      },
      {
        kind: "note",
        tone: "info",
        text: "We treat a removal request as covering every record we can identify as the same person, not only the one you name. If you tell us about one stale record, we do not leave the others behind on a technicality.",
      },
    ],
  },
  {
    id: "customers",
    title: "What customers get in writing",
    blocks: [
      {
        kind: "list",
        items: [
          "A data processing agreement and a current sub-processor list.",
          "Per-field provenance in the API response itself, so an audit does not depend on us answering an email.",
          "Deletion confirmation covering the data we hold, on request.",
        ],
      },
      {
        kind: "note",
        tone: "warning",
        text: "This page is a description of how we operate, not legal advice and not a contract. The binding terms are the ones in your agreement with us.",
      },
    ],
  },
];
