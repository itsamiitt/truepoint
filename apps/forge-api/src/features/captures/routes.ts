// captures — the capture ingest edge (07 §capture ingest API): POST /v1/captures (single). The whole chain
// is server-authoritative — gating (kill-switch + per-tenant flag) → size caps → schema validate → scope
// re-pin → endpoint allowlist → rate-limit (fail-open) → land + enqueue → 202. Client-side SDK guards are
// never trusted (07 §Security). Exposed as a factory so it is unit-testable with injected fakes.
import { type RateLimiter, envelopeByteSize, recordByteSize } from "@leadwolf/forge-core";
import { type CaptureAck, type IngestionEnvelopeV2, ingestionEnvelopeV2 } from "@leadwolf/types";
import { type Context, Hono } from "hono";

export interface CapturesDeps {
  /** Bound @leadwolf/forge-core landEnvelope over the real store/object-store/queue. */
  land: (envelope: IngestionEnvelopeV2) => Promise<CaptureAck>;
  rateLimit: RateLimiter;
  /** Resolve the authenticated caller + whether it carries a capture scope (P-01.15) from the Bearer token. */
  resolveCaller: (
    c: Context,
  ) =>
    | { callerId: string; tenantId: string; captureScoped: boolean }
    | null
    | Promise<{ callerId: string; tenantId: string; captureScoped: boolean } | null>;
  gate: { captureEnabled: boolean; isTenantEnabled: (tenantId: string) => boolean };
  caps: { maxEnvelopeBytes: number; maxRecordBytes: number; endpointAllowlist: readonly string[] };
}

export function createCapturesApp(deps: CapturesDeps): Hono {
  const app = new Hono();

  app.post("/v1/captures", async (c) => {
    const caller = await deps.resolveCaller(c);
    if (!caller) return c.json({ error: "unauthorized" }, 401);

    // The capture principal must be capture-scoped (P-01.15): an exfiltrated or general web/admin user token
    // (scope:[]) cannot inject raw captures into the pipeline. Deny-by-default — only the extension credential
    // (scope:["extension"]) clears this. Checked before the feature gate so a wrong-scope token learns nothing
    // about whether capture is enabled.
    if (!caller.captureScoped) {
      return c.json({ error: "insufficient_scope", scope: "extension" }, 403);
    }

    // Gating: capture is DARK unless the global kill-switch is on AND the tenant is enabled (ADR-0046).
    if (!deps.gate.captureEnabled || !deps.gate.isTenantEnabled(caller.tenantId)) {
      return c.json({ error: "capture_disabled" }, 403);
    }

    // Cheap pre-parse reject. Content-Length is client-declared and therefore advisory — it is a fast path for
    // an honest oversized client, NOT the enforcement point (that is the derived-size check below, and the
    // socket-level `maxRequestBodySize` pinned to this same cap in server.ts). Rejecting here avoids buffering
    // and JSON-parsing a body we already know we will refuse.
    const declaredLength = Number(c.req.header("content-length") ?? Number.NaN);
    if (Number.isFinite(declaredLength) && declaredLength > deps.caps.maxEnvelopeBytes) {
      return c.json({ error: "envelope_too_large" }, 413);
    }

    const raw = await c.req.json().catch(() => null);
    const parsed = ingestionEnvelopeV2.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_envelope", detail: parsed.error.issues[0]?.message }, 400);
    }
    const parsedEnvelope = parsed.data;

    // Trust boundary: the envelope tenant MUST match the token (never ingest into another tenant, §A).
    if (parsedEnvelope.scope.tenantId !== caller.tenantId) {
      return c.json({ error: "scope_mismatch" }, 403);
    }

    // MEASURE the payloads; do not ask the client how big they are (F-0.1). `size` and `byteSize` arrive as
    // plain numbers on the wire and fed every size decision below — so `size: 1` cleared the envelope cap and
    // the byte throttle, and `byteSize: 0` cleared the per-record cap. Both are overwritten here with the real
    // UTF-8 lengths, so the client's values never reach a decision; the same derivation runs again inside
    // landEnvelope, which is what makes the object-store threshold trustworthy too.
    const envelope: IngestionEnvelopeV2 = {
      ...parsedEnvelope,
      records: parsedEnvelope.records.map((r) => ({
        ...r,
        byteSize: recordByteSize(r.rawPayload),
      })),
      size: envelopeByteSize(parsedEnvelope.records),
    };

    // Hard size caps (413) — the SDK should have chunked a too-large batch.
    if (envelope.size > deps.caps.maxEnvelopeBytes) {
      return c.json({ error: "envelope_too_large" }, 413);
    }
    if (envelope.records.some((r) => r.byteSize > deps.caps.maxRecordBytes)) {
      return c.json({ error: "record_too_large" }, 413);
    }

    // In-repo endpoint allowlist re-check (anti-tamper; the SDK's is UX only, §Security).
    if (envelope.records.some((r) => !deps.caps.endpointAllowlist.includes(r.endpoint))) {
      return c.json({ error: "endpoint_not_allowed" }, 400);
    }

    // Extended checkCaptureRate (record + byte), 429 + Retry-After; fails open on Redis outage (§A).
    const rl = await deps.rateLimit.check(caller.callerId, envelope.records.length, envelope.size);
    if (!rl.allowed) {
      c.header("Retry-After", String(rl.retryAfter ?? 60));
      return c.json({ error: "rate_limited" }, 429);
    }

    // Land verbatim (idempotent on content_hash) + enqueue parse; never blocks on the DAG (202, [S46]).
    // Provenance is server-authoritative (P-01.13): the recorded capturer is the AUTHENTICATED caller, never the
    // client-declared envelope.capturedBy — the four-eyes maker is later derived from it, so a spoofed value must
    // not be able to launder a self-approval into the gold layer.
    const ack = await deps.land({ ...envelope, capturedBy: caller.callerId });
    return c.json(ack, 202);
  });

  return app;
}
