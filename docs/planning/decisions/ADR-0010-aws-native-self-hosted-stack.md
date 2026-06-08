# ADR-0010 — AWS-native, self-hosted stack (build-our-own auth)

- **Status:** Accepted
- **Date:** 2026-05-29
- **Context doc:** [01-tech-stack.md](../01-tech-stack.md), [02-architecture.md](../02-architecture.md)

## Context

The team chose an **AWS-native, self-hosted** posture: if AWS offers a managed equivalent, use it; otherwise self-host on AWS infrastructure we control. External SaaS is limited to what the product genuinely requires (Stripe; customer-system integrations like Salesforce/HubSpot/Apollo/ZoomInfo/LinkedIn; GitHub for code+CI). This reverses several earlier PaaS-leaning picks (Better-Auth, managed search, third-party error/analytics) and the NestJS/Fastify framework choice.

## Decision

**Runtime & framework:** **Hono on Bun**, containerized on **ECS Fargate** behind an ALB (replaces NestJS/Fastify). API style: **tRPC** for the internal Next.js app + **REST/OpenAPI** (`@hono/zod-openapi`) for the public API. **Drizzle** ORM retained ([ADR-0001](./ADR-0001-orm-drizzle.md)).

**Frontend:** Next.js 15 + React 19 on **S3 + CloudFront** (static export for marketing/app shell; `standalone` on ECS for dynamic SSR). Tailwind v4 + shadcn/ui; Zustand + TanStack Query/Table/Form.

**Data:** **Aurora PostgreSQL Serverless v2** (0.5–256 ACU, Multi-AZ, PITR) + **RDS Proxy** for connection pooling; IAM DB auth; logical replication on (CDC). **ElastiCache Redis** (cluster mode) for cache + BullMQ + pub/sub. **Self-hosted Typesense** for search ([ADR-0002](./ADR-0002-search-postgres-then-engine.md)). **Self-hosted ClickHouse** on EC2 for event analytics once any event table crosses ~50M rows / >2s queries (CDC via Debezium).

**Realtime:** Postgres LISTEN/NOTIFY + SSE from ECS, Redis pub/sub to fan out across instances.

**Auth: self-built on Lucia + Postgres + Redis** (replaces Better-Auth/Auth.js). Libraries (not services): `lucia`, `arctic` (OAuth), `@node-rs/argon2`, `@oslojs/otp` (TOTP MFA), `@node-saml/node-saml` (SAML SSO), `rate-limiter-flexible`. New tables: `user_sessions`, `user_oauth_accounts`, `user_mfa`, `user_password_resets`, `tenant_sso_configs` (see [03 §9](../03-database-design.md)).

**Email/files:** SES (transactional, via React Email) with SNS→SQS bounce/complaint handling; S3 for all objects (pre-signed up/downloads, CloudFront for public assets).

**Observability (self-hosted):** GlitchTip (errors), PostHog (product analytics, on EC2), CloudWatch + Grafana (metrics/logs), X-Ray (tracing), CloudWatch Synthetics (uptime).

**Infra/CD:** Terraform (separate infra repo, state in S3+DynamoDB), one AWS account per env via Organizations; GitHub Actions → ECR → CodeDeploy blue/green; CloudFront + WAF + Shield; Route 53; Secrets Manager + Parameter Store. **Two repos:** Turborepo app monorepo (Bun workspaces, **Biome** for lint/format) + infra repo. Heavy one-off jobs on **AWS Batch** (Fargate).

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| AWS-native self-hosted (this ADR) | Chosen | Full control, no per-MAU pricing, single-vendor compliance story, lower spend at scale. |
| PaaS-leaning (Vercel/Neon/Clerk/Resend/Sentry) | Rejected | Faster to start, but per-MAU/usage costs, data spread across vendors, less control. |
| NestJS on Fastify | Rejected | Hono on Bun is lighter/faster and fits the container model; DI/guard patterns reproduced with middleware. |

## Consequences

- **Positive:** complete data ownership; lower cost at scale (crossover ~5–10K users); one compliance surface (AWS shared-responsibility); no surprise vendor pricing.
- **Negative (consciously accepted):**
  - **Build & operate auth ourselves: ~6–12 engineer-weeks** plus ongoing security upkeep (credential-stuffing monitoring, key rotation, OWASP) — and it gets audited under SOC 2.
  - **Real ops capability required:** ≥1 DevOps-fluent engineer (Terraform/ECS/Aurora/IAM); platform team by ~15 engineers.
  - **Self-hosting Typesense/ClickHouse/PostHog/GlitchTip** = more moving parts to run, back up, and patch.
  - **Compliance burden is ours** above the AWS infra layer (3–6 months pre-audit, $30–100K/cert).
  - Higher early spend than PaaS (~$400–800/mo MVP) — see [01 §scaling](../01-tech-stack.md).
- **DR:** Aurora PITR + cross-region warm standby; S3 cross-region replication; RTO 1h / RPO 5m; quarterly DR drills.

## Revisit if
Auth maintenance or self-hosting ops outweigh the savings/control at the current team size — selectively adopt a managed service for the most painful component (most likely auth) without changing the rest.
