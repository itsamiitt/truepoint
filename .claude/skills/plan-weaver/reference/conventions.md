# LeadWolf Planning — House Style

> Every edit `plan-weaver` makes must be **indistinguishable** from the existing docs. Match these
> conventions exactly. When in doubt, open a neighboring doc and mirror it.

## Structure & headings

- **L1 (`#`)** = document title, prefixed with its number: `# 03 — Database Design`.
- **L2 (`##`)** = numbered major sections: `## 1. Vision`, `## 2. Conventions`, … Keep numbering
  **consecutive** (no gaps) when inserting a section; renumber following sections if you insert in the
  middle, and fix any `§` references that pointed at them.
- **L3 (`###`)** = subsections, numbered when they form a sequence: `### 4.1 Access`, `### 4.2 Delete`.
- **L4** = rare; only for deep detail (e.g. entity field breakdowns in 03).

## Links

- **Within `docs/planning/`:** relative paths — `./01-tech-stack.md`,
  `./decisions/ADR-0001-orm-drizzle.md`. From inside `decisions/`, go up: `../03-database-design.md`.
- **Section references in prose:** `[NN §S](./NN-name.md#anchor)` style, e.g.
  `[07 §3](./07-billing-credits.md)` or `[03 §8](./03-database-design.md#8-credits--billing-tables)`.
  Anchors are GitHub-style: lowercase, spaces→hyphens, punctuation dropped.
- **No bare URLs**, no absolute file paths inside the docs.
- When you add a reference one way, add the reciprocal link if `doc-map.md` marks the pair bidirectional.

## Tables

- Markdown **grid tables only** (pipes + `|---|`). No HTML, no CSV.
- Header row + separator row, then data rows. Keep columns aligned enough to read in source.
- Decision log (00 §7) columns: `Area | Decision | Why / ADR`. Feature matrix (05) uses `●` to mark a
  milestone cell. Risk register (10) columns: `# | Risk | Impact | Mitigation | Owner milestone`.

## Frontmatter & metadata

- **Planning docs (00–10, README): NO YAML frontmatter.**
- **ADRs:** inline metadata block right under the title:
  ```
  - **Status:** Accepted
  - **Date:** YYYY-MM-DD
  - **Context doc:** [01-tech-stack.md](../01-tech-stack.md), [03-database-design.md](../03-database-design.md)
  ```
  Status values: `Proposed` | `Accepted` | `Superseded by ADR-NNNN` | `Deprecated`.

## Diagrams & code

- **Mermaid** for *architecture/flow* (flowchart, sequenceDiagram, erDiagram) — not for low-level
  detail. Keep diagrams self-contained.
- **Code blocks** are language-labelled triple backticks: ` ```sql `, ` ```ts `, ` ```json `,
  ` ```yaml `. SQL/DDL and TS interfaces are *illustrative* (real code lives in the eventual repo).

## Values & units

- **Credits** are whole integers (`1 credit`). Provider cost is `cost_micros` (micro-dollars, bigint).
- **Confidence** is a decimal in `[0, 1]` (e.g. `0.95`).
- **IDs** are UUID v7 strings. Timestamps `timestamptz`, ISO-8601 UTC in prose.
- **Pricing is placeholder** until decided — reference 07 §1, never hardcode a price in prose.

## Voice & emphasis

- **Bold** for first-use **terms** and key choices; *italics* for *modes*/qualifiers (e.g. *MVP*).
- Concise, declarative, opinionated. Short paragraphs and bullets over walls of text.
- Use a leading blockquote (`>`) for a doc's one-line purpose statement where existing docs do.
- Lines wrap ~100 chars in the existing docs; match that wrapping in edited paragraphs.

## Editing discipline

- **Surgical edits.** Change the smallest span that does the job; don't reflow unrelated content.
- **Preserve each doc's existing section order and numbering** unless the change requires otherwise.
- After any structural change (new/removed/renumbered section), re-check every `§` reference that
  could point at it (see `consistency-checklist.md`).
