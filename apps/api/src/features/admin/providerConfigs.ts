// providerConfigs.ts — platform-admin provider-config endpoints (13 §3.6). Mounted under /api/v1/admin, so
// the parent router already applied authn + platformAdmin (the `pa` gate); provider config is a sensitive
// platform control (data sources + spend), so these additionally require the super_admin staff role. All
// reads/writes go through withPlatformTx (cross-tenant owner visibility + a platform_audit_log row). No
// provider SECRET is ever returned. `health` is a PASSIVE signal from provider_calls call-STATUS history
// (no live probe, no secret touched); `keyHint` stays deferred/null — a masked secret hint is security-
// owned (it needs KMS-decrypted key material). Month-to-date spend + recent health are real cross-tenant
// aggregations over provider_calls (status/cost counts only, never response_payload).

import { providerConfigRepository, withPlatformTx } from "@leadwolf/db";
import {
  NotFoundError,
  type ProviderConfigView,
  ValidationError,
  deriveProviderHealth,
  providerBudgetSchema,
  providerEnabledToggleSchema,
} from "@leadwolf/types";
import { type Context, Hono } from "hono";
import type { ApiVariables } from "../../middleware/authn.ts";
import { requireStaffRole } from "../../middleware/requireStaffRole.ts";

// The fixed set of enrichment providers the platform supports (13 §3.6). Admins toggle / budget these; they
// cannot add providers from the console, so this list — not user input — is the source of valid provider ids.
const KNOWN_PROVIDERS: ReadonlyArray<{ provider: string; label: string }> = [
  { provider: "apollo", label: "Apollo" },
  { provider: "zoominfo", label: "ZoomInfo" },
  { provider: "clearbit", label: "Clearbit" },
];
const LABEL = new Map(KNOWN_PROVIDERS.map((p) => [p.provider, p.label]));

export const providerConfigRoutes = new Hono<{ Variables: ApiVariables }>();

// Provider config moves spend + data-source posture → super_admin only (above the coarse `pa` gate).
providerConfigRoutes.use("*", requireStaffRole("super_admin"));

const actorOf = (c: Context<{ Variables: ApiVariables }>) => ({
  userId: c.get("claims").sub,
  ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
});

/** First instant of the current month, UTC — the lower bound for month-to-date provider spend. */
function startOfMonthUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Lower bound (24h ago) for the PASSIVE provider-health window over provider_calls call-status history. */
function startOfHealthWindowUtc(): Date {
  return new Date(Date.now() - 24 * 60 * 60 * 1000);
}

/** List the supported providers merged with their stored config + live month-to-date spend (masked). */
providerConfigRoutes.get("/", async (c) => {
  const providers = await withPlatformTx(actorOf(c), "admin.list_provider_configs", async (tx) => {
    const [configs, mtd, healthCounts] = await Promise.all([
      providerConfigRepository.list(tx),
      providerConfigRepository.monthToDateCentsByProvider(tx, startOfMonthUtc()),
      providerConfigRepository.recentHealthByProvider(tx, startOfHealthWindowUtc()),
    ]);
    const byProvider = new Map(configs.map((r) => [r.provider, r]));
    return KNOWN_PROVIDERS.map(({ provider, label }): ProviderConfigView => {
      const cfg = byProvider.get(provider);
      return {
        provider,
        label,
        enabled: cfg?.enabled ?? true,
        keyHint: null, // WIRE: masked last-4 from the KMS-managed provider secret store
        rateLimitPerMin: cfg?.rateLimitPerMin ?? null,
        monthlyBudgetCents: cfg?.monthlyBudgetCents ?? null,
        monthToDateCents: mtd[provider] ?? 0,
        health: deriveProviderHealth(
          healthCounts[provider] ?? { hit: 0, miss: 0, rateLimited: 0, error: 0 },
        ),
      };
    });
  });
  return c.json({ providers });
});

/** Enable or disable a provider. Unknown provider → 404 (the id is validated against KNOWN_PROVIDERS). */
providerConfigRoutes.post("/:provider/enabled", async (c) => {
  const provider = c.req.param("provider");
  const label = LABEL.get(provider);
  if (!label) throw new NotFoundError(`Unknown provider '${provider}'.`);
  const parsed = providerEnabledToggleSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  await withPlatformTx(actorOf(c), "admin.set_provider_enabled", (tx) =>
    providerConfigRepository.upsertEnabled(tx, provider, label, parsed.data.enabled),
  );
  return c.json({ ok: true, provider, enabled: parsed.data.enabled });
});

/** Set a provider's monthly cost budget (cents). Unknown provider → 404. */
providerConfigRoutes.post("/:provider/budget", async (c) => {
  const provider = c.req.param("provider");
  const label = LABEL.get(provider);
  if (!label) throw new NotFoundError(`Unknown provider '${provider}'.`);
  const parsed = providerBudgetSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  await withPlatformTx(actorOf(c), "admin.set_provider_budget", (tx) =>
    providerConfigRepository.upsertBudget(tx, provider, label, parsed.data.monthly_budget_cents),
  );
  return c.json({ ok: true, provider, monthlyBudgetCents: parsed.data.monthly_budget_cents });
});
