# diagrams/

Mermaid and `.mmd` diagram sources for the plans-pricing-credits package.

Holds the diagrams referenced by `01`–`07` (notably `06_Architecture_And_Data.md` and the
`07_Implementation_Roadmap.md` synthesis): credit-flow / grant-spend-refund sequences, the
counter→ledger (M11) migration, the org→team→user allocation hierarchy (M12 leases), the Stripe
top-up + webhook grant path, and the subscription/renewal/dunning state machines (proposed,
`ADR-0041`).

Conventions:
- Each diagram is a fenced `mermaid` block in the owning doc **and/or** a standalone `*.mmd` file
  here, named `NN-short-slug.mmd` to match its doc.
- Tag any node representing deferred infra with its gating tag (e.g. `[M11-ledger]`, `[Stripe]`)
  so a diagram never implies built-today state.
- Plain LF line endings; GitHub-flavored Markdown.
