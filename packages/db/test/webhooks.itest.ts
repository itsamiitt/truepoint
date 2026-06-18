// webhooks.itest.ts — the Unit-16 Definition-of-Done proof on a real Postgres 16 (10/14): Testcontainers by
// default, or an external server via ITEST_DATABASE_URL (see itestDb.ts). Requires generated src/migrations
// (`bun run --filter @leadwolf/db generate`). Named *.itest.ts so default `bun test` skips it; run explicitly:
// `bun test packages/db/test/webhooks.itest.ts`.
//
// Proves the outbound-webhook invariants (09 §10, 26 §4, G-INT-5): (1) the SSRF guard rejects internal /
// loopback / metadata targets at create; (2) create returns the signing secret once + persists it ENCRYPTED
// (never in clear); (3) a self-test ping signs with the documented HMAC scheme + the receiver verifies it +
// the attempt is recorded; (4) replay re-POSTs the SAME payload with a freshly-VALID signature + records a
// new delivery; (5) replay of a missing delivery / deleted subscription fails cleanly; (6) subscriptions +
// deliveries are workspace-scoped — RLS isolates workspace A from B for leadwolf_app and fails closed when
// the GUC is unset.
//
// The dispatcher's SSRF guard blocks loopback, so the end-to-end delivery tests opt into the documented
// TEST-ONLY escape hatch (WEBHOOK_ALLOW_LOOPBACK=1) to reach an in-process receiver. Production never sets it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Core = typeof import("../../core/src/index.ts");
type Db = typeof import("../src/index.ts");

let dbHandle: ItestDb;
let core: Core;
let dbMod: Db;
let admin: ReturnType<typeof postgres>;
let appUrl: string;
let tenantA = "";
let tenantB = "";
let wsA = "";
let wsB = "";
let ownerA = "";

interface Received {
  signature: string | null;
  event: string | null;
  body: string;
}

/** A throwaway loopback HTTP receiver recording every inbound webhook so the test can verify the signature. */
function startReceiver(): Promise<{
  url: string;
  received: Received[];
  close: () => Promise<void>;
}> {
  const received: Received[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        received.push({
          signature: req.headers["x-truepoint-signature"]?.toString() ?? null,
          event: req.headers["x-truepoint-event"]?.toString() ?? null,
          body,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/hook`,
        received,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** Verify a `t=…,v1=…` signature header against a body with the documented HMAC-SHA256 scheme. */
function verifySignature(header: string | null, body: string, secret: string): boolean {
  const m = header?.match(/^t=(\d+),v1=([0-9a-f]+)$/);
  if (!m) return false;
  const [, t, v1] = m;
  const expected = createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex");
  return v1 === expected;
}

async function seedWorkspace(
  slug: string,
): Promise<{ tenantId: string; workspaceId: string; ownerId: string }> {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  await admin`INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${t!.id}, ${u!.id}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${t!.id}, ${slug}, ${slug}, true, ${u!.id}) RETURNING id`;
  return { tenantId: t!.id, workspaceId: w!.id, ownerId: u!.id };
}

/** Create a subscription pointed at `url` with a known plaintext secret (returns id + secret for the test). */
async function seedSubscription(
  tenantId: string,
  workspaceId: string,
  url: string,
): Promise<{ id: string; secret: string }> {
  const secret = core.generateSigningSecret();
  const id = await dbMod.webhookRepository.insertSubscription(
    { tenantId, workspaceId },
    {
      tenantId,
      workspaceId,
      url,
      events: ["reveal.completed"],
      signingSecretEnc: core.encryptSigningSecret(secret),
      secretPrefix: core.secretPrefixOf(secret),
      createdByUserId: null,
    },
  );
  return { id, secret };
}

beforeAll(async () => {
  process.env.NODE_ENV = "test"; // the SSRF loopback escape hatch is gated on this (bun sets it; be explicit)
  dbHandle = await startItestDb("webhooks");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  appUrl = dbHandle.appUrl;

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tenantA, workspaceId: wsA, ownerId: ownerA } = await seedWorkspace("acme"));
  ({ tenantId: tenantB, workspaceId: wsB } = await seedWorkspace("globex"));

  core = await import("../../core/src/index.ts");
  dbMod = await import("../src/index.ts");
}, 180_000);

afterAll(async () => {
  const { closeDb } = await import("@leadwolf/db");
  await closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("Unit-16 outbound webhooks DoD", () => {
  test("the SSRF guard rejects internal / loopback / metadata targets at create", async () => {
    process.env.WEBHOOK_ALLOW_LOOPBACK = "0"; // guard fully armed
    for (const bad of [
      "http://169.254.169.254/latest/meta-data/",
      "http://127.0.0.1:8080/hook",
      "http://localhost/hook",
      "http://10.0.0.5/hook",
      "http://192.168.1.1/hook",
      "http://[::1]/hook",
      "http://[::ffff:127.0.0.1]/hook", // IPv4-mapped loopback (canonicalizes to ::ffff:7f00:1)
      "http://[::ffff:10.0.0.1]/hook", // IPv4-mapped private
      "http://0.0.0.0/hook",
      "http://2130706433/hook", // decimal-encoded 127.0.0.1
      "ftp://example.com/hook",
      "http://metadata.google.internal/x",
    ]) {
      await expect(
        core.createWebhookSubscription({
          scope: { tenantId: tenantA, workspaceId: wsA },
          url: bad,
          events: ["reveal.completed"],
          createdByUserId: ownerA,
        }),
      ).rejects.toBeInstanceOf(core.SsrfError);
    }
    // A public host passes the guard.
    await expect(core.assertSafeWebhookUrl("https://example.com/hook")).resolves.toBeDefined();
    // No subscription rows were created by the rejected attempts.
    const [n] =
      await admin`SELECT count(*)::int AS n FROM webhook_subscriptions WHERE workspace_id = ${wsA}`;
    expect((n as { n: number }).n).toBe(0);
  });

  test("create returns the signing secret once + stores it ENCRYPTED, never in clear", async () => {
    process.env.WEBHOOK_ALLOW_LOOPBACK = "1"; // allow the loopback receiver target
    const { url, close } = await startReceiver();
    try {
      const result = await core.createWebhookSubscription({
        scope: { tenantId: tenantA, workspaceId: wsA },
        url,
        events: ["reveal.completed", "score.updated"],
        createdByUserId: ownerA,
      });
      expect(result.signingSecret).toMatch(/^whsec_[0-9a-f]{64}$/);

      const [row] = await admin`
        SELECT signing_secret_enc, secret_prefix FROM webhook_subscriptions WHERE id = ${result.id}`;
      const enc = (row as { signing_secret_enc: Uint8Array }).signing_secret_enc;
      expect(Buffer.from(enc).toString("utf8")).not.toContain(result.signingSecret); // never in clear
      expect(core.decryptSigningSecret(enc)).toBe(result.signingSecret); // recoverable for re-signing
      expect((row as { secret_prefix: string }).secret_prefix.startsWith("whsec_")).toBe(true);
    } finally {
      await close();
      process.env.WEBHOOK_ALLOW_LOOPBACK = "0";
    }
  });

  test("self-test ping signs with the HMAC scheme, the receiver verifies it, and it is recorded", async () => {
    process.env.WEBHOOK_ALLOW_LOOPBACK = "1";
    const { url, received, close } = await startReceiver();
    try {
      const { id, secret } = await seedSubscription(tenantA, wsA, url);
      const res = await core.sendTestEvent({
        scope: { tenantId: tenantA, workspaceId: wsA },
        webhookId: id,
      });

      expect(res?.status).toBe("succeeded");
      expect(res?.responseCode).toBe(200);
      expect(received.length).toBe(1);
      expect(received[0]!.event).toBe("webhook.test");
      expect(verifySignature(received[0]!.signature, received[0]!.body, secret)).toBe(true);

      // The attempt is recorded as a delivery row.
      const [n] = await admin`
        SELECT count(*)::int AS n FROM webhook_deliveries WHERE webhook_id = ${id} AND event_type = 'webhook.test'`;
      expect((n as { n: number }).n).toBe(1);
      // A self-test for a subscription in another workspace 404s (null) — workspace-scoped lookup.
      const cross = await core.sendTestEvent({
        scope: { tenantId: tenantB, workspaceId: wsB },
        webhookId: id,
      });
      expect(cross).toBeNull();
    } finally {
      await close();
      process.env.WEBHOOK_ALLOW_LOOPBACK = "0";
    }
  });

  test("replay re-POSTs the SAME payload with a freshly-VALID signature + records a new delivery", async () => {
    process.env.WEBHOOK_ALLOW_LOOPBACK = "1";
    const { url, received, close } = await startReceiver();
    try {
      const { id, secret } = await seedSubscription(tenantA, wsA, url);
      const payload = { contactId: "c-123", revealType: "email" };
      const [d] = await admin`
        INSERT INTO webhook_deliveries (tenant_id, workspace_id, webhook_id, event_type, payload, status, response_code)
        VALUES (${tenantA}, ${wsA}, ${id}, 'reveal.completed', ${admin.json(payload)}, 'failed', 500)
        RETURNING id`;
      const deliveryId = (d as { id: string }).id;

      const outcome = await core.replayDelivery({
        scope: { tenantId: tenantA, workspaceId: wsA },
        deliveryId,
      });
      expect(outcome.ok).toBe(true);

      // The receiver got the replayed event, and the signature verifies (recomputed, not the stored one).
      expect(received.length).toBe(1);
      expect(received[0]!.event).toBe("reveal.completed");
      expect(verifySignature(received[0]!.signature, received[0]!.body, secret)).toBe(true);
      expect(JSON.parse(received[0]!.body).data).toEqual(payload); // SAME payload re-sent

      // A NEW delivery row was recorded for the replay (the original + the replay = 2 for this subscription).
      const [n] =
        await admin`SELECT count(*)::int AS n FROM webhook_deliveries WHERE webhook_id = ${id}`;
      expect((n as { n: number }).n).toBe(2);
    } finally {
      await close();
      process.env.WEBHOOK_ALLOW_LOOPBACK = "0";
    }
  });

  test("replay of a missing delivery / a deleted subscription fails cleanly (no throw)", async () => {
    const missing = await core.replayDelivery({
      scope: { tenantId: tenantA, workspaceId: wsA },
      deliveryId: "00000000-0000-7000-8000-000000000000",
    });
    expect(missing).toEqual({ ok: false, reason: "delivery_not_found" });

    // A delivery whose subscription was deleted (webhook_id NULL) can't be replayed.
    const [orphan] = await admin`
      INSERT INTO webhook_deliveries (tenant_id, workspace_id, webhook_id, event_type, payload, status, response_code)
      VALUES (${tenantA}, ${wsA}, NULL, 'reveal.completed', ${admin.json({})}, 'failed', 500)
      RETURNING id`;
    const gone = await core.replayDelivery({
      scope: { tenantId: tenantA, workspaceId: wsA },
      deliveryId: (orphan as { id: string }).id,
    });
    expect(gone).toEqual({ ok: false, reason: "subscription_gone" });
  });

  test("subscriptions + deliveries are workspace-scoped: RLS isolates A from B and fails closed when unset", async () => {
    // Seed a subscription + a delivery in workspace B via the repository (RLS-scoped writes).
    const { id: subBId } = await seedSubscription(tenantB, wsB, "https://example.com/b");
    await dbMod.webhookRepository.insertDelivery(
      { tenantId: tenantB, workspaceId: wsB },
      {
        tenantId: tenantB,
        workspaceId: wsB,
        webhookId: subBId,
        eventType: "reveal.completed",
        payload: { ws: "B" },
        status: "succeeded",
        responseCode: 200,
      },
    );

    // Workspace A cannot see B's subscription or delivery through the repository (RLS + predicate).
    const aSubs = await dbMod.webhookRepository.listSubscriptions({
      tenantId: tenantA,
      workspaceId: wsA,
    });
    expect(aSubs.some((s) => s.id === subBId)).toBe(false);
    const aTarget = await dbMod.webhookRepository.getDispatchTarget(
      { tenantId: tenantA, workspaceId: wsA },
      subBId,
    );
    expect(aTarget).toBeNull();

    // Raw RLS proof for the non-BYPASSRLS app role: scoped to B sees B's rows; unset GUC sees nothing.
    const app = postgres(appUrl, { max: 1, onnotice: () => {} });
    try {
      const seenB = await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_workspace_id', ${wsB}, true)`;
        const [r] = await tx`SELECT count(*)::int AS n FROM webhook_deliveries`;
        return (r as { n: number }).n;
      });
      expect(seenB).toBeGreaterThanOrEqual(1);

      const seenUnset = await app.begin(async (tx) => {
        const [r] = await tx`SELECT count(*)::int AS n FROM webhook_deliveries`;
        return (r as { n: number }).n;
      });
      expect(seenUnset).toBe(0); // fail-closed

      const seenSubsUnset = await app.begin(async (tx) => {
        const [r] = await tx`SELECT count(*)::int AS n FROM webhook_subscriptions`;
        return (r as { n: number }).n;
      });
      expect(seenSubsUnset).toBe(0);
    } finally {
      await app.end();
    }
  });
});
