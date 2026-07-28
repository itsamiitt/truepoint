// webhookRoutes.ts — the PUBLIC CRM inbound surface (crm-sync 00 §3.3 inbound / §5.1). Session-less, so it
// is mounted BEFORE the authed CRM router (whose `*` authn would 401 these calls), mirroring
// emailWebhookRoutes and dsarPublicRoutes.
//
// THE TRUST CHAIN, in the order it is established — every step gates the next:
//
//  1. SIGNATURE FIRST, over the RAW body. The provider signs with OUR app secret; a passing signature is
//     the only thing that proves the request came from HubSpot/Salesforce at all. Nothing in the payload is
//     read for any purpose other than the verification until it passes, and a missing secret FAILS CLOSED
//     (no secret configured ⇒ every event rejected) rather than accepting unsigned traffic.
//  2. THEN the account id selects the connection. The account id lives in the body, so it is only
//     trustworthy because step 1 already proved the body is the provider's. The lookup is cross-tenant by
//     necessity — a webhook arrives with no session, and discovering which tenant an event belongs to IS
//     the lookup — so it runs on the owner connection and projects ids only.
//  3. THEN everything re-enters withTenantTx under the resolved scope, and is RLS-enforced again.
//
// THE PAYLOAD IS A HINT, NOT DATA. Only the record ID is carried forward; the worker re-fetches the
// canonical record over the authenticated connection (applyInboundEvent). So even a validly-signed event
// can influence WHICH record we look at, never WHAT we write.
//
// ALWAYS 200 ON A HANDLED EVENT, INCLUDING A DUPLICATE. Providers redeliver at-least-once and treat a
// non-2xx as "retry harder"; a redelivery is the normal path, not an error. The DB unique index on
// (connection_id, provider_event_id) is the dedupe wall, and `isNew === false` means "acknowledge, do not
// re-process".

import { env } from "@leadwolf/config";
import { crmConnectionRepository, crmInboundEventRepository, withTenantTx } from "@leadwolf/db";
import { defaultCrmConnectors } from "@leadwolf/integrations";
import { Hono } from "hono";
import { enqueueCrmInbound } from "./crmQueue.ts";

export const crmWebhookRoutes = new Hono();

const connectors = defaultCrmConnectors();

/**
 * The provider's account id, read from the (already signature-verified) body.
 *
 * HubSpot puts `portalId` on each event in its array; Salesforce CDC carries `organizationId`. Both are
 * non-secret identifiers — they select a connection, they do not authorise anything. Returned as a string
 * because HubSpot sends a number and the column is varchar.
 */
function extractAccountId(provider: string, body: unknown): string | null {
  if (provider === "hubspot") {
    const first = Array.isArray(body) ? body[0] : body;
    const portal = (first as { portalId?: unknown } | null)?.portalId;
    return portal === undefined || portal === null ? null : String(portal);
  }
  const org = (body as { organizationId?: unknown } | null)?.organizationId;
  return typeof org === "string" ? org : null;
}

/** The per-provider webhook signing secret. Absent ⇒ the route fails closed for that provider. */
function secretFor(provider: string): string | null {
  if (provider === "hubspot") return env.CRM_HUBSPOT_WEBHOOK_SECRET ?? null;
  if (provider === "salesforce") return env.CRM_SALESFORCE_WEBHOOK_SECRET ?? null;
  return null;
}

crmWebhookRoutes.post("/:provider", async (c) => {
  const provider = c.req.param("provider");
  const connector = connectors[provider as keyof typeof connectors];
  // An unknown provider is a 404 rather than a 400: the path is the only thing an unauthenticated caller
  // controls here, and enumerating which providers exist is not information worth handing out.
  if (!connector) return c.json({ error: "not_found" }, 404);

  const raw = await c.req.text(); // RAW body — verify exactly what the provider signed

  // ── 1. Signature, fail-closed ─────────────────────────────────────────────────────────────────────
  const secret = secretFor(provider);
  if (!secret) return c.json({ error: "not_configured" }, 503);

  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  if (!connector.verifyWebhook(raw, headers, secret)) {
    return c.json({ error: "invalid_signature" }, 401);
  }

  // ── 2. Only now is the body worth reading ─────────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: "invalid_payload" }, 400);
  }

  const accountId = extractAccountId(provider, body);
  if (!accountId) return c.json({ ok: true }); // nothing to attribute → benign no-op, not a retry

  const connection = await crmConnectionRepository.findConnectedByProviderAccount(
    provider,
    accountId,
  );
  // A signed event for a CRM org nobody has connected (or has since disconnected) is not an error —
  // returning non-2xx would make the provider retry an event we will never want.
  if (!connection) return c.json({ ok: true });

  const events = connector.parseWebhookEnvelope(raw);
  if (events.length === 0) return c.json({ ok: true });

  const scope = { tenantId: connection.tenantId, workspaceId: connection.workspaceId };

  // ── 3. RLS-scoped again from here ─────────────────────────────────────────────────────────────────
  const toEnqueue = await withTenantTx(scope, async (tx) => {
    const fresh: Array<{ objectType: string; crmRecordId: string; sourceTag?: string }> = [];
    for (const event of events) {
      const { isNew } = await crmInboundEventRepository.append(tx, {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        connectionId: connection.id,
        provider,
        objectType: event.object,
        crmObjectType: event.object,
        crmRecordId: event.externalId,
        providerEventId: event.eventId,
        sourceTag: event.sourceTag ?? null,
      });
      // The dedupe wall. A redelivery lands here and is acknowledged without being re-processed.
      if (isNew) {
        fresh.push({
          objectType: event.object,
          crmRecordId: event.externalId,
          ...(event.sourceTag ? { sourceTag: event.sourceTag } : {}),
        });
      }
    }
    return fresh;
  });

  // Enqueued AFTER the transaction commits, so a job can never reference an event row that rolled back.
  // Best-effort per event: a failed enqueue is logged by the producer and the reconcile poll is the
  // correctness backstop — the webhook is the LATENCY layer, never the only path a record can arrive by.
  for (const event of toEnqueue) {
    await enqueueCrmInbound({
      scope,
      connectionId: connection.id,
      provider: provider as "salesforce" | "hubspot",
      objectType: event.objectType as "contact" | "account" | "lead" | "deal",
      crmRecordId: event.crmRecordId,
      providerEventId: `${event.crmRecordId}:${event.objectType}`,
      ...(event.sourceTag ? { sourceTag: event.sourceTag } : {}),
    });
  }

  return c.json({ ok: true });
});
