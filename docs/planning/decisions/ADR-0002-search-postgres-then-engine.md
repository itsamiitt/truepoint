# ADR-0002 — Self-hosted Typesense search from day one (behind a SearchPort)

- **Status:** Accepted (amended 2026-05-29 — adopt Typesense from day one)
- **Date:** 2026-05-29
- **Context doc:** [01-tech-stack.md](../01-tech-stack.md), [03-database-design.md](../03-database-design.md)
- **Amendment note:** The original decision was *Postgres-native search first, dedicated engine later*. With the AWS-native stack decision ([ADR-0010](./ADR-0010-aws-native-self-hosted-stack.md)) and the 100M+ target, the team adopts **self-hosted Typesense from day one**. The `SearchPort` abstraction is retained; the "start on Postgres" timing is dropped. Original reasoning kept below as history.

## Context

LeadWolf targets large scale (100M+ rows over time) and needs typo-tolerant, faceted prospect/account search with low latency. Postgres FTS + `pg_trgm` is serviceable at small scale but strains on high-cardinality faceted/typo search at the top end. The team has also chosen an AWS-native, self-hosted posture, so a self-hosted search engine fits the operating model.

## Decision

1. **Typesense, self-hosted on ECS Fargate, from day one** (3-node cluster across 3 AZs for HA, data on EBS gp3, daily snapshots to S3, behind a private ALB reachable only from the API VPC).
2. **All search stays behind a `SearchPort`** interface in `packages/search`; callers never embed engine-specific queries.
3. **Sync via CDC:** a `search-sync` worker subscribes to Aurora Postgres **logical replication** and applies `contacts`/`accounts` changes to Typesense within ~500ms. Postgres remains the system of record; Typesense is the query index.
4. **Search is workspace-scoped:** every query is filtered by `workspace_id` (per the per-workspace model, [ADR-0006](./ADR-0006-per-workspace-multitenant-model.md)); PII stays masked in results.

```ts
interface SearchPort {
  searchContacts(q: ContactQuery, ctx: { workspaceId: string }): Promise<SearchPage<ContactHit>>;
  searchAccounts(q: AccountQuery, ctx: { workspaceId: string }): Promise<SearchPage<AccountHit>>;
  index(entity: 'contact' | 'account', id: string): Promise<void>;
}
```

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **Typesense self-hosted from day one (this ADR)** | Chosen | Fits AWS-native self-host posture; great faceting/typo-tolerance; avoids a later migration. |
| Postgres-native first, engine later (original) | Superseded | Avoided early infra, but a guaranteed future migration given scale + the self-host decision. |
| OpenSearch/Elasticsearch | Rejected (for now) | Heavier to operate than Typesense for this workload. |
| Managed Typesense Cloud | Rejected | Contradicts the AWS-native self-hosted posture (ADR-0010). |

## Consequences

- **Positive:** strong search UX from launch; no mid-life search migration; `SearchPort` keeps callers decoupled; pgvector on Aurora remains available for semantic/NL search later without a separate vector DB.
- **Negative:** operate a Typesense cluster + a CDC sync pipeline from day one (more infra than Postgres-only); eventual consistency (~500ms) between write and index.
- **Mitigation:** Terraform-managed cluster, automated snapshots, monitored CDC lag; `SearchPort` lets us fall back to a Postgres implementation for tiny/dev environments.

## Revisit if
Typesense can't serve a needed query shape or scale — swap the `SearchPort` implementation to OpenSearch (no caller changes).

---

### Historical note (original decision, superseded)
Originally we planned Postgres-native search (`tsvector`/`pg_trgm` + GIN) for MVP behind the `SearchPort`, with a swap trigger to a dedicated engine at ~25–50M rows or >300ms p95. The AWS-native + 100M+ decisions made adopting Typesense immediately the better call.
