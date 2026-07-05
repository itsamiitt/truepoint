// env.ts — the ONLY place process.env is read (16 §10). Validates the runtime environment at boot with
// Zod and exposes a typed, frozen `env`. Any missing/invalid key fails fast before the app serves traffic.

import { z } from "zod";

const csv = (s: string) =>
  s
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

export const appEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

    // Auth service boundary (ADR-0016): the IdP origin + the app origins it may issue tokens to.
    AUTH_ORIGIN: z.string().url(),
    // In-cluster origin used ONLY to FETCH the auth JWKS (apps/api token verification). Optional: when set
    // (e.g. http://auth:3000 on the docker network) the api reads the signing keys over the internal network
    // instead of hairpinning out through the public edge (public DNS → TLS → Caddy → back to the auth
    // container that shares its network). The network LOCATION of the key set moves; the token's issuer/
    // audience are STILL validated against the PUBLIC AUTH_ORIGIN — this never changes the trust boundary.
    // Unset → token.ts falls back to AUTH_ORIGIN, so dev/local/test behaviour is unchanged. Require an
    // http(s) scheme: z.string().url() alone accepts a bare "auth:3000" (it reads "auth" as the scheme), which
    // would pass boot validation but make `new URL("/auth/...", base)` unusable and 401 every request. Failing
    // fast at boot on a scheme-less host:port is the operator-typo guard.
    INTERNAL_AUTH_ORIGIN: z
      .string()
      .url()
      .refine((u) => /^https?:\/\//.test(u), { message: "must start with http:// or https://" })
      .optional(),
    APP_ORIGINS: z.string().transform(csv).pipe(z.array(z.string().url()).min(1)),
    AUTH_COOKIE_DOMAIN: z.string().min(1),

    // Client-IP binding posture for the cross-domain code (ADR-0016 addendum): `strict` = exact match on
    // the normalized IP, `prefix` = same network (/24 IPv4, /64 IPv6) so a proxy first-hop that varies
    // within a network doesn't break a legitimate login, `off` = don't bind (rely on PKCE + single-use +
    // short TTL). Default `prefix` — robust to dual-stack first-hop drift without dropping the protection.
    AUTH_BIND_IP: z.enum(["strict", "prefix", "off"]).default("prefix"),

    // The browser-facing public origins are ALSO inlined into the web/auth bundles at BUILD time
    // (NEXT_PUBLIC_*). Optional here (absent during a bare `next build` or in unit tests), but when present
    // at runtime the prod superRefine asserts they agree with the server-side origins — drift between the
    // baked bundle and the runtime allow-list is the classic "redirects to the app but never logs in" bug.
    NEXT_PUBLIC_APP_ORIGIN: z.string().url().optional(),
    NEXT_PUBLIC_AUTH_ORIGIN: z.string().url().optional(),

    // RFC 9457 problem-details `type` namespace, used ONLY when the api renders an error (server-side). It is a
    // stable identifier, not a live page that must resolve — but keeping it configurable avoids baking a brand
    // domain into packages/types (a browser-imported leaf that must never read process.env). Trailing slash so
    // the code is appended directly: `${ERROR_TYPE_BASE_URL}invalid_token`.
    ERROR_TYPE_BASE_URL: z.string().url().default("https://truepoint.in/errors/"),

    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),
    AUTH_CODE_TTL_SECONDS: z.coerce.number().int().positive().max(120).default(60),

    JWT_SIGNING_KID: z.string().min(1),
    JWT_PRIVATE_KEY_PEM: z.string().default(""),
    JWT_PUBLIC_KEY_PEM: z.string().default(""),
    // Base64 single-line transport for the EdDSA PEMs. A multi-line PEM passed through docker compose
    // `${VAR}` interpolation gets its newlines mangled → importPKCS8 throws → login 503s (token_mint_failed).
    // deploy.sh ships these base64 forms; loadEnv decodes them into the PEM fields. Raw PEM still wins if set.
    JWT_PRIVATE_KEY_PEM_B64: z.string().default(""),
    JWT_PUBLIC_KEY_PEM_B64: z.string().default(""),

    DATABASE_URL: z.string().url(),
    // Optional DIRECT (non-pooled) URL used ONLY for migrations. On Neon the default connection string is
    // the pooled (`-pooler`/PgBouncer) host; migrations run cleaner against the direct host. When unset,
    // migrations fall back to DATABASE_URL (safe — applyMigrations sets `prepare: false` either way).
    DATABASE_MIGRATION_URL: z.string().url().optional(),
    DATABASE_APP_ROLE: z.string().min(1).default("leadwolf_app"),
    // Login passwords for the leadwolf_app / leadwolf_admin roles the migration creates. They're reached via
    // SET ROLE (never logged into directly), so these are inert — but managed Postgres (Neon) rejects weak
    // CREATE ROLE passwords via its control plane. Strong defaults live in applyMigrations; override here.
    DATABASE_APP_ROLE_PASSWORD: z.string().min(8).optional(),
    DATABASE_ADMIN_ROLE_PASSWORD: z.string().min(8).optional(),
    REDIS_URL: z.string().url(),

    BLIND_INDEX_KEY: z.string().min(8),

    // Reveal pricing by reveal_type — PLACEHOLDERS per 07 §1, injected from config and never hardcoded in
    // code paths (14 §5.7). The verified-result charge policy (ADR-0013) adjusts these at M4.
    REVEAL_COST_EMAIL: z.coerce.number().int().min(0).default(1),
    REVEAL_COST_PHONE: z.coerce.number().int().min(0).default(1),
    REVEAL_COST_FULL_PROFILE: z.coerce.number().int().min(0).default(1),

    // Stripe webhook signing secret (whsec_…). Optional in dev/test (Stripe CLI prints one per
    // `stripe listen`); the webhook route fails closed when it is absent.
    STRIPE_WEBHOOK_SECRET: z.string().optional(),

    // Stripe secret key (sk_…) for server-side Checkout Session + subscription creation (M11 commercial,
    // ADR-0041). Optional: absent → the checkout/subscribe endpoints fail closed (503 "billing not configured"),
    // so the paid flow stays dark until a key is set. The webhook (grant) path does not need this key.
    STRIPE_SECRET_KEY: z.string().optional(),
    // Stripe REST API base (overridable for tests/mocks); prod default is the live host.
    STRIPE_API_BASE: z.string().url().default("https://api.stripe.com"),
    // HARD GATES (default FALSE) — the paid flows stay inert until explicitly enabled AND a secret key is set.
    // Checkout = one-off credit-pack purchases (Phase 1); Subscriptions = recurring plans (Phase 2).
    BILLING_CHECKOUT_ENABLED: z
      .string()
      .optional()
      .transform((v) => v === "true"),
    BILLING_SUBSCRIPTIONS_ENABLED: z
      .string()
      .optional()
      .transform((v) => v === "true"),
    // M12 P3 inbound-reply polling (the Gmail-history sweep). Dark by default — nothing polls until enabled.
    EMAIL_INBOX_ENABLED: z
      .string()
      .optional()
      .transform((v) => v === "true"),
    // Teams (Part D, grouping-only). Dark by default — the /api/v1/teams routes 404 + the settings tab hides
    // until enabled.
    TEAMS_ENABLED: z
      .string()
      .optional()
      .transform((v) => v === "true"),
    // Peer-approval (maker-checker) for staff money actions (Part B, decision #4). Dark by default: OFF ⇒ credit
    // adjust/refund execute DIRECTLY (the pre-Part-B path); ON ⇒ they file a request a DIFFERENT operator must
    // approve. Flip ON in production to enforce separation of duties (the stronger control).
    BILLING_APPROVALS_ENABLED: z
      .string()
      .optional()
      .transform((v) => v === "true"),

    // Charge policy for `risky` verification results — ADR-0013: charged-but-flagged by default.
    REVEAL_CHARGE_RISKY: z
      .string()
      .optional()
      .transform((v) => v !== "false"),

    // Per-verifier network timeout (ms) for the reveal path (Reacher email + Twilio phone). Verification is
    // network I/O that runs OUTSIDE the charging tx (14 §3.5), but with no timeout a hung provider hangs the
    // synchronous reveal request. On abort the adapter degrades to the stored status / E.164 format floor (it
    // "didn't run") — never worse than today. Default 5s.
    REVEAL_VERIFY_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

    // Reveal-specific per-caller burst cap (reveals/min, keyed by the verified subject). A dedicated abuse
    // guard on the money endpoint on TOP of the coarse /api throttle — a runaway script or compromised token
    // is bounded by request velocity, not only by the credit balance CHECK. Generous for a human clicking
    // rows, tight for automation. Default 60/min.
    REVEAL_RATE_PER_MIN: z.coerce.number().int().positive().default(60),

    // Enrichment provider keys (06 §3). Absent → that adapter reports `miss` and the waterfall skips it.
    APOLLO_API_KEY: z.string().optional(),
    ZOOMINFO_API_KEY: z.string().optional(),
    CLEARBIT_API_KEY: z.string().optional(),

    // Global daily enrichment cost budget in micro-dollars (06 §6); exhaustion trips the budget breaker.
    ENRICH_DAILY_BUDGET_MICROS: z.coerce.number().int().positive().default(50_000_000),
    // Placeholder per-match provider unit cost in micro-dollars (07 §1), used ONLY to size the bulk re-enrich
    // WORST-CASE ceiling the confirm gate shows (contactIds.length × this). Same unit as ENRICH_DAILY_BUDGET_MICROS
    // and provider_calls.cost_micros, so the per-run cap compares like-for-like. Default $0.10/match; calibrate when
    // the real credit model lands. Never a hard spend limit itself — the confirm gate, per-run cap, and daily
    // breaker are the actual brakes; this only forecasts the ceiling a human confirms.
    ENRICH_COST_MICROS_PER_MATCH: z.coerce.number().int().positive().default(100_000),

    // Email-verification backend (06 §9, 01 §5.2): a self-hosted Reacher (check-if-email-exists) or the
    // hosted Reacher API BASE ORIGIN (e.g. https://api.reacher.email). Absent → the reveal path keeps
    // passThroughVerifier (no grading, today's behaviour). REACHER_API_TOKEN is the hosted-API bearer token
    // — a SECRET, read only here, never client-exposed; omit it for an unauthenticated self-host backend.
    REACHER_BACKEND_URL: z.string().url().optional(),
    REACHER_API_TOKEN: z.string().optional(),

    // Phone validation via Twilio Lookup (06 §9, 01 §5.3): when BOTH are set, the reveal/reverify paths upgrade
    // the E.164 format check to a CARRIER-CONFIRMED valid/invalid. Absent → the E.164 format check only (today's
    // behaviour). The Auth Token is a SECRET (env/KMS), never client-exposed. Carrier line-type (TCPA mobile vs
    // landline) is a migration-gated follow-up (needs a phone_line_type column + Twilio's line_type_intelligence).
    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),

    // Cloudflare Turnstile secret for the identifier step (ADR-0020). Optional: absent → dev passes, prod fails.
    TURNSTILE_SECRET: z.string().optional(),

    // SYSTEM-WIDE MASTER-ARM for tenant auth-policy enforcement on login (P1-01: IP allowlist / allowed methods
    // / session + idle timeout / forced-MFA-enrollment gates in packages/auth). LOCKOUT-CAPABLE, so enforcement
    // requires BOTH this arm AND a per-tenant switch: effective = (this === "true") AND
    // tenant_auth_policies.enforcement_enabled. This arm is the global incident kill-switch — flipping it off
    // disarms every tenant at once; the per-tenant switch (staff-set, default OFF, with a break-glass disable —
    // POST /api/v1/admin/tenants/:id/auth-enforcement) is how an individual VERIFIED tenant is enabled. With
    // this arm off the gates are a strict no-op and do NO policy read (today's exact behavior, the merge-safety
    // guarantee). String, not z.coerce.boolean(), so ONLY "true" enables it — "false"/"0"/"" can never be
    // coerced truthy.
    AUTH_POLICY_ENFORCEMENT_ENABLED: z.string().optional(),

    TYPESENSE_URL: z.string().url().optional(),
    TYPESENSE_API_KEY: z.string().optional(),
    SMTP_URL: z.string().optional(),

    // M12 email subsystem (email-planning/13 P0, D7). The dedicated data key for the mailbox-credential
    // secret store (core/email/secretStore) — the KMS-envelope target. Server-only, never NEXT_PUBLIC_,
    // never logged. Absent in dev/test → the store falls back to deriving a key from BLIND_INDEX_KEY (the
    // same dev-only posture as encryptPii); production MUST inject a dedicated key (rotated, KMS-managed).
    EMAIL_SECRET_KEY: z.string().min(16).optional(),

    // Signing secret for the inbound ESP delivery/bounce/complaint webhook (email-planning/13 P1, 04 §6).
    // Server-only; the webhook route fails CLOSED when it is absent (no secret → every event rejected), the
    // same posture as STRIPE_WEBHOOK_SECRET.
    EMAIL_WEBHOOK_SECRET: z.string().optional(),

    // Google OAuth client for connecting a Gmail mailbox (email-planning/13 P1, D1). Server-only secrets — the
    // client secret is NEVER NEXT_PUBLIC_ and never logged. The redirect URI must exactly equal a URI
    // allow-listed in the Google Cloud console. All three absent → the connect flow is unavailable and fails
    // closed (no provider registered), never a silent misconfiguration.
    GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
    GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
    GOOGLE_OAUTH_REDIRECT_URI: z.string().url().optional(),

    // AI provider (23, ADR-0023). Anthropic Claude behind the AiPort. The API key is a SECRET — read only
    // here, never hardcoded; an absent key makes the adapter fail closed (ai_unavailable), it never throws
    // at construction. The base URL + model id are env-driven so the model is a configurable default
    // (product-self-knowledge: `claude-opus-4-8`), swappable without a code change.
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_BASE_URL: z.string().url().default("https://api.anthropic.com"),
    ANTHROPIC_VERSION: z.string().default("2023-06-01"),
    AI_NL_SEARCH_MODEL: z.string().min(1).default("claude-opus-4-8"),
    // Max NL→search model calls per tenant per UTC day — the per-tenant request budget guard (23 §7). A
    // call that would exceed this is rejected with a budget error BEFORE any model spend.
    AI_NL_SEARCH_DAILY_BUDGET: z.coerce.number().int().positive().default(200),

    // Owner-scoped job visibility (import-and-data-model-redesign 10; the G01 fix). GLOBAL kill-switch of the
    // dual gate: effective scoping = (this === "true") AND the per-tenant `job_visibility_scoped` flag. While
    // off, every job surface (import/reveal/enrichment lists + detail + the home Recent Imports card) keeps
    // its shipped workspace-wide visibility BYTE-IDENTICALLY (the jobVisibility predicate short-circuits;
    // T-V4 parity). Flipping it off at any point is the instant fleet-wide rollback lever (15 §R-P0). Same
    // explicit-"true"-only posture as BULK_IMPORT_ENABLED — "false"/"0"/""/unset can never read truthy.
    JOB_VISIBILITY_SCOPED: z
      .string()
      .optional()
      .transform((v) => v === "true"),
    // Bulk COPY-staging import (backlog #2, phase 6; 15-bulk-import-design). HARD GATE, default FALSE: the whole
    // pipeline is DARK in prod until the COPY spike + a prod object store are ready. While off, the apps/api
    // producer creates/enqueues NOTHING and the apps/workers consumer is not even registered. Modelled on
    // AUTH_POLICY_ENFORCEMENT_ENABLED's posture (a lockout-/risk-capable switch where ONLY an explicit "true"
    // enables it) but kept a real boolean via transform — "false"/"0"/""/unset can never read truthy.
    BULK_IMPORT_ENABLED: z
      .string()
      .optional()
      .transform((v) => v === "true"),
    // Filesystem root for the DEV/TEST local-disk FileStore (packages/core diskFileStore). The PRODUCTION
    // FileStore (S3: presigned multipart + AV-scan-before-promote) is injected at the app composition root later —
    // no AWS SDK is added here; this dir is only the dev adapter's root. Has a sane default so dev/test boot clean.
    BULK_IMPORT_STORAGE_DIR: z.string().min(1).default(".data/bulk-imports"),
    // The sync→bulk promotion threshold (rows): an import larger than this is steered onto the bulk pipeline
    // rather than the inline `imports` queue. Consumed by the promotion logic; a sensible default until tuned.
    BULK_IMPORT_THRESHOLD_ROWS: z.coerce.number().int().positive().default(5000),
    // Unified durable import pipeline v2 (import-and-data-model-redesign 08/09; S-I3 onward). GLOBAL
    // kill-switch of the dual gate: effective v2 = (this === "true") AND the per-tenant `import_v2_enabled`
    // flag (seeded off in 0054). While off, every import surface keeps its shipped behavior BYTE-IDENTICALLY
    // (T1 parity is the proof): POST /imports enqueues the legacy `imports` queue job and GET /imports/:jobId
    // reads BullMQ — no durable row is created or read. Flipping it off at any point is the instant
    // fleet-wide rollback lever (15 §R-P1); executed imports KEEP their durable rows (data is never rolled
    // back by a flag). Same explicit-"true"-only posture as BULK_IMPORT_ENABLED — "false"/"0"/""/unset can
    // never read truthy.
    IMPORT_V2_ENABLED: z
      .string()
      .optional()
      .transform((v) => v === "true"),
    // Tenant-fairness knobs for the unified import queue (import-redesign 09 §2, S-Q2). All revert by env
    // (15 §R-P1: "tuning knobs revert by env"); each 0 = the DISABLED/∞ sentinel restoring legacy behavior.
    // Per-workspace cap on concurrently EXECUTING imports (states validating|staged|running — 08 §2.1's
    // `deferred` parks the overflow, HubSpot's visible-backpressure pattern). Doc 12 publishes the number
    // (N=3, worst-case per-workspace chunk fan-out = K×N). 0 = no cap (nothing ever defers).
    IMPORT_WORKSPACE_JOB_CAP: z.coerce.number().int().nonnegative().default(3),
    // Bounded rolling chunk fan-out window K (09 §2.2): a copy drive enqueues only the first K chunk jobs;
    // each completion enqueues the next pending band (self-perpetuating; reaper-healed). 0 = ∞ sentinel =
    // legacy enqueue-all (also dodges addBulk degradation above ~1k jobs).
    IMPORT_CHUNK_WINDOW: z.coerce.number().int().nonnegative().default(2),
    // How long a DEFERRED fast job waits before its cooperative cap re-check re-claims it (Phase A: fast
    // payloads carry rows, so the deferred lane re-enqueues with this delay rather than parking without
    // transport — importV2.ts documents the bound).
    IMPORT_DEFER_RECHECK_DELAY_MS: z.coerce.number().int().positive().default(15_000),
    // Evidence-substrate dual-write (prospect-database-platform I0 / audit P01): when ON, the ER resolve path
    // ALSO appends an immutable source_records evidence row + a match_links cluster-membership row alongside the
    // shipped deterministic landing. DEFAULT-OFF: while off the writers are never called and NOTHING changes — the
    // golden landing stays byte-identical. Flipping it to authoritative (the survivorship projector reads the log)
    // is a SEPARATE, CI-parity-gated step. Same explicit-"true"-only posture as BULK_IMPORT_ENABLED.
    INGESTION_EVIDENCE_ENABLED: z
      .string()
      .optional()
      .transform((v) => v === "true"),
    // Bulk CSV enrichment v2 (prospect-database-platform I3 / audit A3/P08): the confirm-before-spend money path —
    // the POST /enrichment/jobs/:jobId/confirm gate, the apps/api producer onto BULK_ENRICHMENT_QUEUE, and the
    // apps/workers consumer. DEFAULT-OFF: while off the confirm endpoint 403s, the producer enqueues NOTHING, and
    // the consumer is not registered — so NO bulk run can EVER spend. Turning it on is a SEPARATE, CI-parity-gated
    // step (the worst-case ceiling + per-run cap + daily budget breaker must all be wired first). Same explicit-
    // "true"-only posture as BULK_IMPORT_ENABLED — "false"/"0"/""/unset can never read truthy.
    BULK_ENRICHMENT_ENABLED: z
      .string()
      .optional()
      .transform((v) => v === "true"),
    // Async BULK REVEAL job (reveal-experience Phase 3, ADR-0029/0036): the confirm-before-spend money path —
    // POST /contacts/reveal-jobs/:id/confirm leases the worst-case ceiling, the apps/api producer enqueues the
    // drive onto BULK_REVEAL_QUEUE, and the apps/workers consumer reveals each contact + releases the unspent
    // remainder. DEFAULT-OFF: while off the confirm endpoint 403s, the producer enqueues NOTHING, and the
    // consumer is not registered — so NO bulk-reveal job can EVER spend. Turning it on is a SEPARATE,
    // CI-parity-gated step. Same explicit-"true"-only posture as BULK_ENRICHMENT_ENABLED.
    BULK_REVEAL_ENABLED: z
      .string()
      .optional()
      .transform((v) => v === "true"),
    // Realtime SSE backbone (reveal-experience Phase 4, ADR-0027): the transactional event outbox + the relay
    // (outbox → Redis pub/sub) + the authenticated SSE stream. DEFAULT-OFF: while off, writers append NO outbox
    // rows, the relay is not registered, and GET /events/stream 404s — so the whole realtime path is inert and
    // the frontend's existing polling/refetch stays the source of truth. Turning it on is a SEPARATE,
    // CI-parity-gated step. Same explicit-"true"-only posture as BULK_REVEAL_ENABLED.
    REALTIME_SSE_ENABLED: z
      .string()
      .optional()
      .transform((v) => v === "true"),
    // Probabilistic ER shadow mode (prospect-database-platform I5 / audit P02, A10): when ON, the leader-locked ER
    // sweep scores candidate person pairs (Fellegi-Sunter) and PROPOSES dups as match_links rows with
    // review_status='pending' + match_method='splink' — the human-review queue the DB-Ops surface reads. SHADOW-ONLY:
    // it NEVER auto-confirms/merges/re-points and a pending row is provably inert (the deterministic resolve ignores
    // review_status; the projector counts source_records, not match_links). DEFAULT-OFF: while off the sweep is not
    // registered and NOTHING is proposed. Turning it on is safe (read-only effect: it only fills a review queue);
    // acting on a proposal (confirm/merge) is a SEPARATE human + executor step. Same explicit-"true"-only posture.
    ER_SHADOW_ENABLED: z
      .string()
      .optional()
      .transform((v) => v === "true"),
    // Chrome-extension capture connector (prospect-database-platform I6 / audit P07): a SCRAPING ingestion source
    // (a rep's browser extension submits observations captured from a page). DEFAULT-OFF and DARK until LEGAL
    // SIGN-OFF (ToS/BrowserGate, 06/09): while off the connector is not registered, so POST /api/v1/ingest returns
    // 400 'no connector' for chrome_extension and NOTHING is captured. When on, the connector HARD-GATES every
    // envelope on a valid consent/ToS context before any observation is produced; suppression-block-before-surface
    // + the async land pipeline are separate later slices. Same explicit-"true"-only posture as BULK_IMPORT_ENABLED.
    CHROME_EXTENSION_ENABLED: z
      .string()
      .optional()
      .transform((v) => v === "true"),
    // Low-balance notifier sweep (plans-pricing-credits). HARD GATE, default FALSE: DARK in prod until a
    // customer-facing delivery channel (email / in-app, ADR-0027) is wired. While off, the apps/workers consumer
    // is not even registered and nothing is scanned. The sweep is READ-ONLY — it charges and deletes NOTHING.
    // Only an explicit "true" enables it ("false"/"0"/""/unset can never read truthy).
    LOW_BALANCE_NOTIFIER_ENABLED: z
      .string()
      .optional()
      .transform((v) => v === "true"),
    // The reveal-credit-balance threshold (credits) at/under which the notifier flags a tenant. Mirrors the
    // admin /billing/low-balance default; a sensible default until tuned.
    LOW_BALANCE_NOTIFIER_THRESHOLD: z.coerce.number().int().min(0).default(100),
    // Credit-ledger reconciliation sweep (M11, ADR-0029). HARD GATE, default FALSE: DARK until the historical
    // backfill has brought pre-ledger tenants to 0 drift (before it, every old tenant reads as drifted — noise,
    // not a bug). While off, the apps/workers consumer is not registered and nothing is scanned. The sweep is
    // READ-ONLY — it corrects nothing; a real drift is a bug to investigate. Only an explicit "true" enables it.
    BILLING_RECON_ENABLED: z
      .string()
      .optional()
      .transform((v) => v === "true"),
    // One-time credit-ledger historical backfill sweep (M11, ADR-0029). HARD GATE, default FALSE. Enable it to
    // reconstruct the ledger for pre-ledger tenants (idempotent + self-terminating via the opening_balance
    // marker); once billing-recon reports 0 drift it can go back off. While off, the consumer is not registered.
    BILLING_LEDGER_BACKFILL_ENABLED: z
      .string()
      .optional()
      .transform((v) => v === "true"),
  })
  .superRefine((val, ctx) => {
    // In production the refresh cookie is scoped to AUTH_COOKIE_DOMAIN; it MUST equal the auth origin's host.
    // A bare registrable-domain value (e.g. truepoint.in) would make it a parent-domain cookie sent to
    // app.*/api.* too — the larger blast radius ADR-0016 rejects. The base schema only checks min(1).
    if (val.NODE_ENV !== "production") return;
    let authHost: string;
    try {
      authHost = new URL(val.AUTH_ORIGIN).hostname;
    } catch {
      return; // AUTH_ORIGIN invalid → already reported by its own .url() check
    }
    if (val.AUTH_COOKIE_DOMAIN !== authHost) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AUTH_COOKIE_DOMAIN"],
        message: `must equal the AUTH_ORIGIN host "${authHost}" (host-only cookie scope), got "${val.AUTH_COOKIE_DOMAIN}"`,
      });
    }

    // Origin self-consistency (ADR-0016): the public origins baked into the bundles at build time MUST agree
    // with the server-side origins read at runtime, or `exchangeCode`'s exact-match origin check fails and
    // login dies with an opaque 400. Assert only when the NEXT_PUBLIC_* values are present in the process env
    // (they are here via env_file) — fail fast and loud at boot instead of silently breaking sign-in.
    if (val.NEXT_PUBLIC_APP_ORIGIN && !val.APP_ORIGINS.includes(val.NEXT_PUBLIC_APP_ORIGIN)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["NEXT_PUBLIC_APP_ORIGIN"],
        message: `must be one of APP_ORIGINS [${val.APP_ORIGINS.join(", ")}] — the build-time app origin must be an allow-listed runtime origin, or the cross-domain token exchange fails`,
      });
    }
    if (val.NEXT_PUBLIC_AUTH_ORIGIN && val.NEXT_PUBLIC_AUTH_ORIGIN !== val.AUTH_ORIGIN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["NEXT_PUBLIC_AUTH_ORIGIN"],
        message: `must equal AUTH_ORIGIN "${val.AUTH_ORIGIN}" (the baked auth origin must match the runtime auth origin)`,
      });
    }
  });

export type AppEnv = z.infer<typeof appEnvSchema>;

/**
 * Resolve a PEM from its two possible transports. A raw (non-empty) PEM wins — backward compatible with
 * deployments that inject the PEM directly. Otherwise decode the base64 transport, which survives the
 * shell→compose interpolation that mangles a multi-line PEM (ADR-0016 addendum). Returns "" when neither
 * is supplied (dev/build/test): token signing simply throws later, surfaced by the boot/deploy self-test.
 */
export function decodeKeyMaterial(raw: string, b64: string): string {
  if (raw.trim() !== "") return raw;
  if (b64.trim() === "") return "";
  return Buffer.from(b64, "base64").toString("utf8");
}

// ── Surface-aware boot (worker-platform plan 15 §4 — Phase 2, boot isolation) ───────────────────────────────
// The whole-app schema used to be a worker single-point-of-failure: because loadEnv() validates EVERY required
// key and crashes on any miss, a missing web/auth-ONLY key (a cookie domain, a JWT kid) kept the WORKER dark —
// presenting exactly like the by-design stuck-jobs state (a diagnosed false-positive; see
// docs/planning/worker-platform/02-root-cause-analysis.md). Under `LEADWOLF_SURFACE=worker` the keys below are
// relaxed: a missing one is backed by a schema-valid sentinel at parse time, and any RUNTIME ACCESS to that key
// throws loudly (fail-closed per key — the coupling is removed, the discipline is kept). Worker-required keys
// (REDIS_URL, DATABASE_URL, BLIND_INDEX_KEY, APP_ORIGINS — the send footer reads it) still crash boot when
// missing, on every surface.

/** The value `LEADWOLF_SURFACE` must hold for the worker relaxation to apply. Any other value (or unset) keeps
 *  today's strict whole-app validation. */
export const WORKER_SURFACE = "worker";

/** Required keys that are WEB/AUTH-ONLY — no packages/core, packages/db, or apps/workers code path reads them
 *  on the worker surface. Grow this list only with a grep proving the worker never touches the key. */
const WORKER_RELAXED_KEYS = ["AUTH_ORIGIN", "AUTH_COOKIE_DOMAIN", "JWT_SIGNING_KID"] as const;
type WorkerRelaxedKey = (typeof WORKER_RELAXED_KEYS)[number];

/** Schema-valid placeholders for missing relaxed keys. The `.invalid` TLD is reserved (RFC 2606) — these can
 *  never resolve, and the cookie-domain sentinel equals the origin sentinel's host so the production
 *  superRefine holds. They are never observable: the access proxy throws before a caller can read one. */
const WORKER_SENTINELS: Record<WorkerRelaxedKey, string> = {
  AUTH_ORIGIN: "http://worker-surface.invalid",
  AUTH_COOKIE_DOMAIN: "worker-surface.invalid",
  JWT_SIGNING_KID: "worker-surface-unused",
};

/** Boot self-test data: which surface parsed the env, and which relaxed keys were absent (backed by throwing
 *  sentinels). The workers entrypoint logs this so "did the worker boot, and with what?" is answerable at a
 *  glance (plan 15 §4.1). */
export interface SurfaceReport {
  surface: string;
  relaxedMissing: readonly string[];
}

/**
 * Pure, testable core of loadEnv (mirrors the decodeKeyMaterial pattern: unit tests pass constructed sources
 * and never mutate process.env). Parses `source` against the whole-app schema; under the worker surface,
 * missing relaxed keys are sentinel-backed at parse time and access-guarded afterwards.
 */
export function resolveAppEnv(
  source: Record<string, string | undefined>,
  surface: string | undefined,
): { env: AppEnv; report: SurfaceReport } {
  const relaxedMissing: string[] = [];
  let effective = source;
  if (surface === WORKER_SURFACE) {
    const injected = { ...source };
    for (const key of WORKER_RELAXED_KEYS) {
      if (injected[key] === undefined || injected[key] === "") {
        injected[key] = WORKER_SENTINELS[key];
        relaxedMissing.push(key);
      }
    }
    effective = injected;
  }

  const parsed = appEnvSchema.safeParse(effective);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  // Decode the base64 PEM transport into the effective PEM fields so token.ts can read env.JWT_*_PEM
  // unchanged. Done here (the one process.env reader) rather than in the schema so it stays a pure transform.
  const resolved = {
    ...parsed.data,
    JWT_PRIVATE_KEY_PEM: decodeKeyMaterial(
      parsed.data.JWT_PRIVATE_KEY_PEM,
      parsed.data.JWT_PRIVATE_KEY_PEM_B64,
    ),
    JWT_PUBLIC_KEY_PEM: decodeKeyMaterial(
      parsed.data.JWT_PUBLIC_KEY_PEM,
      parsed.data.JWT_PUBLIC_KEY_PEM_B64,
    ),
  };
  const frozen = Object.freeze(resolved);

  // Fail-loud access guard: reading a sentinel-backed key is a bug (a worker path touching web/auth config),
  // surfaced at the exact call site instead of as a silently-wrong sentinel value. Throwing from a `get` trap
  // is proxy-invariant-safe on a frozen target (invariants constrain returned values, not throws).
  const guarded: AppEnv =
    relaxedMissing.length === 0
      ? frozen
      : new Proxy(frozen, {
          get(target, prop, receiver) {
            if (typeof prop === "string" && relaxedMissing.includes(prop)) {
              throw new Error(
                `env.${prop} was accessed on the worker surface but is not set. This key is web/auth-only ` +
                  "and was relaxed at boot (LEADWOLF_SURFACE=worker). If a worker path genuinely needs it, " +
                  "set it in the worker environment — or remove it from WORKER_RELAXED_KEYS in env.ts.",
              );
            }
            return Reflect.get(target, prop, receiver);
          },
        });

  return { env: guarded, report: { surface: surface ?? "app", relaxedMissing } };
}

const loaded = resolveAppEnv(process.env, process.env.LEADWOLF_SURFACE);

export const env: AppEnv = loaded.env;
/** The surface report for THIS process (see SurfaceReport). Workers log it at boot. */
export const envSurfaceReport: SurfaceReport = loaded.report;

/** Origins allowed to exchange/refresh tokens (CORS allow-list; never a wildcard). */
export const appOrigins = (): readonly string[] => env.APP_ORIGINS;

/** True when `origin` is an exact, allow-listed app origin. */
export const isAllowedOrigin = (origin: string | null | undefined): boolean =>
  origin != null && env.APP_ORIGINS.includes(origin);
