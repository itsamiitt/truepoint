# ownership-matrix — who owns each cross-cutting rule

So nothing falls through the cracks between the three skills and the planning corpus. "Owner" = who
decides/enforces the rule; "Contract lives in" = the single source of truth for *what* the rule is;
"Checked here" = `enterprise-architecture`'s review/audit pass flags violations against that contract
(it does not restate or fork it).

| Rule | Owner | Contract lives in | Enforced / checked by |
|---|---|---|---|
| Feature-based layout, layer separation, barrels, naming, file-size (this repo) | **enterprise-architecture** | `architecture-contract.md` → 16, 02 | this skill's workflow + review |
| Generic feature-based conventions (any project) | `scalable-architecture` | its `REFERENCE.md` | that skill |
| App→app / deep-package / cross-feature import bans | **enterprise-architecture** | 16 §5 | **`dependency-cruiser` CI gate** (`templates/dependency-cruiser.cjs`) |
| Zod validation at the edge **and** at the service boundary | docs/planning | 16 §7, 02 §5; `packages/types` | code review step here; types in `packages/types` |
| Central error handling (RFC-9457 error classes + error middleware) | docs/planning | `packages/types` (error classes), `apps/api` middleware chain (02 §5) | api middleware; checked here |
| **Tenant-scoping in every workspace-scoped repository query (RLS GUC)** | **enterprise-architecture** (first-class invariant) | 02 §4, 03 §9, ADR-0006 | review checklist here + Postgres RLS at runtime |
| Idempotency + money-path invariants (FOR UPDATE, unique keys, Idempotency-Key) | docs/planning | 02 §3.1, 07 §3, ADR-0007 | checked here when touching reveal/billing code |
| Testing-per-layer (co-located unit; Testcontainers integration; provider cassettes; Playwright e2e) | docs/planning | 16 §9, 14 §2 | repo test layout; checked here |
| Drizzle migration discipline (generated SQL, expand/contract) | docs/planning | 02 §10, 03 | `packages/db/src/migrations`; checked here |
| Config/secrets — env only via `packages/config`, `.env.example` shape-only | docs/planning | 16 §10, 02 §8 | checked here (no scattered `process.env`) |
| LLM/AI provider isolation (behind a `core` port, versioned prompts) | docs/planning | 16 §11 | checked here when touching AI features; see `claude-api` skill for provider specifics |
| Planning-doc coherence (decision log, matrices, ADRs, cross-links) | `plan-weaver` | `docs/planning/**` | that skill |

## Notes
- **Don't duplicate contracts.** Where the contract lives in `docs/planning`, this skill *checks
  conformance* and links to it — it does not copy the rule (copies drift; `plan-weaver` keeps the
  originals coherent).
- **Tenant-scoping is called out explicitly** as an architecture invariant (not a style nit) precisely so
  it cannot be silently dropped when adding a feature: a new `<entity>Repository.ts` that touches
  workspace-scoped data without the RLS GUC is a blocking violation.
- When a rule is genuinely *new* (not yet in any doc), route it to its owner: architecture-shaped → here
  or `scalable-architecture`; planning/decision-shaped → `plan-weaver` (and an ADR).
