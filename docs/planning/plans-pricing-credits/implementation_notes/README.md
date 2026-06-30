# implementation_notes/

Build-time notes for the plans-pricing-credits program: per-phase recipes, local/CI gate
sequences, sequencing decisions, and open questions surfaced during implementation. Feeds the
`07_Implementation_Roadmap.md` synthesis.

Holds:
- Per-phase (P0–P6) build recipes and the "build safe gaps, spec the deferred" discipline.
- The local gate sequence for this host (Bun typecheck, `bun x biome`, LF tree, unit) vs the
  CI/docker gates (itests, migration apply) — recall this host has **no docker**, so new-table
  migrations are hand-authored and CI-verified.
- Cross-cutting reminders: the counter→ledger (M11) cutover plan, lease (M12) wiring, Stripe
  Billing/Checkout integration steps, feature-flag rollout for invoicing/multi-currency.
- Decision-gated waits (OD-1..OD-8) and the proposed-ADR triggers (`ADR-0041` subscriptions,
  `ADR-0042` hierarchical allocation).

Convention: notes are working artifacts, not customer-facing spec; keep them dated and link the
owning numbered doc. Plain LF line endings.
