// dataSources.ts — platform-admin management of the data-source ORIGIN fleet (provider_origins, 0117;
// docs/planning/linkedin-source-ingestion/ §origins). Mounted under /api/v1/admin (parent applied authn +
// platformAdmin); origin config moves spend + secrets → the same providers:manage (super_admin) capability
// as provider-configs. All writes through withPlatformTx (audited).
//
// SECRETS DISCIPLINE: the API key is WRITE-ONLY through this surface. It arrives cleartext in a create/
// update body over TLS, is sealed at the core boundary (sealOriginKey → AES-GCM ciphertext + "…tail" hint)
// before it touches the repository, and is NEVER echoed — every read returns api_key_hint only. The
// masked-hint posture providerConfigs deferred ("keyHint stays null — needs KMS") is real here because the
// key is sealed at ingest, not decrypted for display.
//
// The TEST endpoint fires ONE live company fetch (refresh:true — deliberately bypasses the vendor capture
// cache so the test proves the ORIGIN, not the cache) against a canned public sales-nav URL and returns
// status + latency ONLY — never the payload (a test button must not become a data-exfil surface).

import {
  fetchLinkedinCompany,
  invalidateOriginCache,
  salesNavCompanyUrl,
  sealOriginKey,
} from "@leadwolf/core";
import { providerOriginRepository, withPlatformTx } from "@leadwolf/db";
import {
  NotFoundError,
  ValidationError,
  originCreateSchema,
  originPatchSchema,
  originPauseSchema,
} from "@leadwolf/types";
import { type Context, Hono } from "hono";
import type { ApiVariables } from "../../middleware/authn.ts";
import { requireCapability } from "../../middleware/requireCapability.ts";

export const dataSourceRoutes = new Hono<{ Variables: ApiVariables }>();
dataSourceRoutes.use("*", requireCapability("providers:manage"));

const actorOf = (c: Context<{ Variables: ApiVariables }>) => ({
  userId: c.get("claims").sub,
  ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
});

/** Today the console manages exactly one fleet; the provider segment is pinned server-side so the route
 *  cannot be used to invent provider namespaces. Widen deliberately when a second fleet exists. */
const PROVIDER = "linkedin_api";

/** LinkedIn's own numeric id for the "LinkedIn" company page — a stable, public, canned test target. */
const TEST_COMPANY_ID = "1337";

// Body contracts live in @leadwolf/types (originCreateSchema/originPatchSchema/originPauseSchema) — the
// leaf-package rule: apps/api carries no zod of its own.

/** https + no embedded credentials + no path/query/fragment — an origin is an ORIGIN, not an endpoint.
 *  The fetch layer appends the contract paths itself; a stored path would smuggle a different API shape. */
function assertSaneOrigin(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ValidationError("baseUrl must be a valid URL.");
  }
  if (parsed.protocol !== "https:") throw new ValidationError("baseUrl must be https.");
  if (parsed.username || parsed.password)
    throw new ValidationError("baseUrl must not embed credentials.");
  if ((parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search || parsed.hash)
    throw new ValidationError("baseUrl must be a bare origin (no path, query, or fragment).");
}

dataSourceRoutes.get("/", async (c) => {
  const origins = await withPlatformTx(actorOf(c), "admin.data_sources.list", (tx) =>
    providerOriginRepository.listForAdmin(tx, PROVIDER),
  );
  return c.json({ provider: PROVIDER, origins });
});

dataSourceRoutes.post("/", async (c) => {
  const parsed = originCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new ValidationError("Body must be { label, baseUrl, apiKey?, priority? }.");
  assertSaneOrigin(parsed.data.baseUrl);

  const sealed = parsed.data.apiKey ? sealOriginKey(parsed.data.apiKey) : null;
  const id = await withPlatformTx(
    actorOf(c),
    "admin.data_sources.create",
    (tx) =>
      providerOriginRepository.create(tx, {
        provider: PROVIDER,
        label: parsed.data.label,
        baseUrl: parsed.data.baseUrl.replace(/\/$/, ""),
        apiKeyEnc: sealed?.apiKeyEnc ?? null,
        apiKeyHint: sealed?.apiKeyHint ?? null,
        priority: parsed.data.priority,
      }),
    { targetType: "provider_origin", metadata: { label: parsed.data.label } },
  );
  invalidateOriginCache(PROVIDER);
  return c.json({ id }, 201);
});

dataSourceRoutes.patch("/:id", async (c) => {
  const parsed = originPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Body must be a partial origin.");
  if (parsed.data.baseUrl) assertSaneOrigin(parsed.data.baseUrl);

  // apiKey semantics: absent = keep; null = clear; string = replace (sealed).
  const sealed =
    parsed.data.apiKey === undefined
      ? undefined
      : parsed.data.apiKey === null
        ? null
        : sealOriginKey(parsed.data.apiKey);

  const found = await withPlatformTx(
    actorOf(c),
    "admin.data_sources.update",
    (tx) =>
      providerOriginRepository.update(tx, c.req.param("id"), {
        label: parsed.data.label,
        baseUrl: parsed.data.baseUrl?.replace(/\/$/, ""),
        priority: parsed.data.priority,
        ...(sealed === undefined
          ? {}
          : sealed === null
            ? { apiKeyEnc: null, apiKeyHint: null }
            : { apiKeyEnc: sealed.apiKeyEnc, apiKeyHint: sealed.apiKeyHint }),
      }),
    { targetType: "provider_origin", targetId: c.req.param("id") },
  );
  if (!found) throw new NotFoundError("Origin not found.");
  invalidateOriginCache(PROVIDER);
  return c.json({ ok: true });
});

dataSourceRoutes.post("/:id/pause", async (c) => {
  const body = originPauseSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw new ValidationError("Body must be { paused: boolean }.");
  const found = await withPlatformTx(
    actorOf(c),
    body.data.paused ? "admin.data_sources.pause" : "admin.data_sources.resume",
    (tx) => providerOriginRepository.setPaused(tx, c.req.param("id"), body.data.paused),
    { targetType: "provider_origin", targetId: c.req.param("id") },
  );
  if (!found) throw new NotFoundError("Origin not found.");
  invalidateOriginCache(PROVIDER);
  return c.json({ ok: true });
});

dataSourceRoutes.delete("/:id", async (c) => {
  const found = await withPlatformTx(
    actorOf(c),
    "admin.data_sources.delete",
    (tx) => providerOriginRepository.remove(tx, c.req.param("id")),
    { targetType: "provider_origin", targetId: c.req.param("id") },
  );
  if (!found) throw new NotFoundError("Origin not found.");
  invalidateOriginCache(PROVIDER);
  return c.json({ ok: true });
});

/** Live one-shot probe through the WHOLE chain machinery (cache dropped first so the probe cannot be
 *  answered by a stale origin list). Status + latency only — never the payload. */
dataSourceRoutes.post("/:id/test", async (c) => {
  invalidateOriginCache(PROVIDER);
  const started = Date.now();
  const result = await fetchLinkedinCompany(salesNavCompanyUrl(TEST_COMPANY_ID), {
    refresh: true,
  });
  return c.json({
    status: result.status,
    httpStatus: result.status === "rejected" ? result.httpStatus : null,
    latencyMs: Date.now() - started,
  });
});
