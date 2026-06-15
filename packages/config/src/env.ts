// env.ts — the ONLY place process.env is read (16 §10). Validates the runtime environment at boot with
// Zod and exposes a typed, frozen `env`. Any missing/invalid key fails fast before the app serves traffic.

import { z } from "zod";

const csv = (s: string) =>
  s
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

export const appEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Auth service boundary (ADR-0016): the IdP origin + the app origins it may issue tokens to.
  AUTH_ORIGIN: z.string().url(),
  APP_ORIGINS: z.string().transform(csv).pipe(z.array(z.string().url()).min(1)),
  AUTH_COOKIE_DOMAIN: z.string().min(1),

  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),
  AUTH_CODE_TTL_SECONDS: z.coerce.number().int().positive().max(120).default(60),

  JWT_SIGNING_KID: z.string().min(1),
  JWT_PRIVATE_KEY_PEM: z.string().default(""),
  JWT_PUBLIC_KEY_PEM: z.string().default(""),

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

  TYPESENSE_URL: z.string().url().optional(),
  TYPESENSE_API_KEY: z.string().optional(),
  SMTP_URL: z.string().optional(),
}).superRefine((val, ctx) => {
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
});

export type AppEnv = z.infer<typeof appEnvSchema>;

function loadEnv(): AppEnv {
  const parsed = appEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return Object.freeze(parsed.data);
}

export const env: AppEnv = loadEnv();

/** Origins allowed to exchange/refresh tokens (CORS allow-list; never a wildcard). */
export const appOrigins = (): readonly string[] => env.APP_ORIGINS;

/** True when `origin` is an exact, allow-listed app origin. */
export const isAllowedOrigin = (origin: string | null | undefined): boolean =>
  origin != null && env.APP_ORIGINS.includes(origin);
