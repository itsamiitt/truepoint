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

    // Charge policy for `risky` verification results — ADR-0013: charged-but-flagged by default.
    REVEAL_CHARGE_RISKY: z
      .string()
      .optional()
      .transform((v) => v !== "false"),

    // Enrichment provider keys (06 §3). Absent → that adapter reports `miss` and the waterfall skips it.
    APOLLO_API_KEY: z.string().optional(),
    ZOOMINFO_API_KEY: z.string().optional(),
    CLEARBIT_API_KEY: z.string().optional(),

    // Global daily enrichment cost budget in micro-dollars (06 §6); exhaustion trips the budget breaker.
    ENRICH_DAILY_BUDGET_MICROS: z.coerce.number().int().positive().default(50_000_000),

    // Cloudflare Turnstile secret for the identifier step (ADR-0020). Optional: absent → dev passes, prod fails.
    TURNSTILE_SECRET: z.string().optional(),

    // GLOBAL kill-switch for tenant auth-policy enforcement on login (P1-01: IP allowlist + session timeout
    // gates in packages/auth). LOCKOUT-CAPABLE: a mis-set tenant policy (e.g. an IP allowlist that excludes a
    // real user, or a too-short session timeout) can lock a user — or a whole org — out. So the gates are a
    // strict no-op unless this is the literal string "true": unset/any-other-value = OFF = today's exact
    // behavior (the merge-safety guarantee). String, not z.coerce.boolean(), so ONLY "true" enables it —
    // "false"/"0"/"" can never be coerced truthy. The per-tenant feature-flag refinement (enable per verified
    // tenant, with a break-glass disable path) is the follow-up; this single global flag is the first increment.
    AUTH_POLICY_ENFORCEMENT_ENABLED: z.string().optional(),

    TYPESENSE_URL: z.string().url().optional(),
    TYPESENSE_API_KEY: z.string().optional(),
    SMTP_URL: z.string().optional(),

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

function loadEnv(): AppEnv {
  const parsed = appEnvSchema.safeParse(process.env);
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
  return Object.freeze(resolved);
}

export const env: AppEnv = loadEnv();

/** Origins allowed to exchange/refresh tokens (CORS allow-list; never a wildcard). */
export const appOrigins = (): readonly string[] => env.APP_ORIGINS;

/** True when `origin` is an exact, allow-listed app origin. */
export const isAllowedOrigin = (origin: string | null | undefined): boolean =>
  origin != null && env.APP_ORIGINS.includes(origin);
