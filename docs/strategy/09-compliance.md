# Compliance & Trust — expressed as product requirements

Not legal advice; a build checklist derived from how this category is
regulated. Engage counsel for the beachhead's jurisdictions before Phase 3
(contributions) and again before Phase 6 (phones, mailbox). Treat every item
as an acceptance criterion, not a policy PDF.

## Hard product rules (mirrored in CLAUDE.md §Rules 4)
1. No background or bulk scraping of logged-in platforms (LinkedIn etc.);
   extension acts only on user-initiated actions on the page they're viewing.
   Site ToS and store policies are business-existential risks — an extension
   ban kills the wedge. Counsel reviews the extension's capture design.
2. Never read, store, or transmit message content from mailbox/dialer
   integrations — structured event metadata only (bounce, reply-bool,
   connect-disposition). Enforced at the connector schema level.
3. Business-contact data only: work emails, work phones, role, company. No
   sensitive categories, ever; personal addresses out of scope.
4. Every ingestion path tags a lawful basis; anything untaggable doesn't
   enter the graph (A-01).
5. Contributor consent is explicit, granular (per channel; per CRM
   object/field; exclusion lists), logged, and revocable — revocation stops
   future flow and is recorded (C-05, C-02).
6. Community-tier conditionality (expanded free access while a contribution
   channel is active) is a data-as-consideration model that regulators
   scrutinize. Counsel reviews its framing per jurisdiction (freely-given
   consent vs. contractual necessity), and a genuine no-contribution Free
   tier must always exist as a real alternative.

## Data-subject rights (the people IN the database)
- Public self-service portal: view-what-you-hold, correct, opt out, erase.
- Erasure = tombstone provenance event → graph reprocess → propagation to
  export suppression; automated SLA ≤72h (A-02).
- Suppression service enforced at every egress (S-11) incl. regional
  do-not-call lists for phone fields where applicable.
- Notice obligations (e.g., GDPR Art. 14-style) planned per beachhead
  jurisdiction with counsel — batched notice workflows if required.
- Regional gating: field types (esp. mobile numbers) enabled per-jurisdiction
  behind config, not code forks.

## Customer-facing trust (what RevOps asks in procurement)
- Provenance summary visible per record ("verified ⟨n⟩ days ago via ⟨k⟩
  independent signals") — S-10 and trust are the same feature.
- Audit-trail exports; sub-processor list; deletion certifications.
- Security baseline: encryption at rest/in transit, role-based access,
  provenance store on stricter access tier (C-02), audit logging. Target a
  recognized security attestation when enterprise motion starts (Phase 5).

## Review gates (block merges, not launches)
Any PR touching collection/storage/display/export/deletion of personal data
must state: data elements touched · lawful-basis tag · consent surface ·
suppression enforcement point · erasure propagation path. The /jtbd-review
skill includes this checklist.
