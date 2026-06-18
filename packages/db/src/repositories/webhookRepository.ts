// webhookRepository.ts — data access for outbound webhooks (webhooks domain, 09 §10, M10). The ONLY
// data-access path for webhook_subscriptions + webhook_deliveries; everything is workspace-scoped via RLS
// (withTenantTx) AND an explicit workspace_id predicate (defence in depth, mirroring salesNavLinkRepository).
// The signing secret is handled as an opaque encrypted blob here — encryption/decryption + signing live in
// @leadwolf/core (this layer never sees plaintext). `events` is a closed-enum string[] narrowed by the api.

import { and, desc, eq } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { webhookDeliveries, webhookSubscriptions } from "../schema/webhooks.ts";

export interface WebhookSubscriptionInsert {
  tenantId: string;
  workspaceId: string;
  url: string;
  events: string[];
  /** Pre-encrypted signing secret (iv|tag|ciphertext) — core encrypts; this layer stores the blob. */
  signingSecretEnc: Uint8Array;
  secretPrefix: string;
  createdByUserId?: string | null;
}

/** A subscription as listed — the secret blob is deliberately NOT selected (never returned to the UI). */
export interface WebhookSubscriptionRecord {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  secretPrefix: string;
  createdAt: Date;
}

/** The dispatch view: everything needed to sign + POST, INCLUDING the encrypted secret (server-side only). */
export interface WebhookDispatchTarget {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  signingSecretEnc: Uint8Array;
}

export interface WebhookDeliveryInsert {
  tenantId: string;
  workspaceId: string;
  webhookId: string | null;
  eventType: string;
  payload: unknown;
  status: string;
  responseCode?: number | null;
}

export interface WebhookDeliveryRecord {
  id: string;
  webhookId: string | null;
  eventType: string;
  status: string;
  responseCode: number | null;
  attemptedAt: Date;
}

/** A past delivery re-hydrated for replay: the original event + payload, plus the still-live target id. */
export interface WebhookDeliveryForReplay {
  id: string;
  webhookId: string | null;
  eventType: string;
  payload: unknown;
}

export const webhookRepository = {
  async insertSubscription(scope: TenantScope, input: WebhookSubscriptionInsert): Promise<string> {
    return withTenantTx(scope, async (tx: Tx) => {
      const inserted = await tx
        .insert(webhookSubscriptions)
        .values(input)
        .returning({ id: webhookSubscriptions.id });
      return inserted[0]!.id;
    });
  },

  /** Newest-first subscriptions for the workspace. Workspace-scoped via RLS + explicit predicate. */
  async listSubscriptions(scope: TenantScope): Promise<WebhookSubscriptionRecord[]> {
    return withTenantTx(scope, (tx) =>
      tx
        .select({
          id: webhookSubscriptions.id,
          url: webhookSubscriptions.url,
          events: webhookSubscriptions.events,
          active: webhookSubscriptions.active,
          secretPrefix: webhookSubscriptions.secretPrefix,
          createdAt: webhookSubscriptions.createdAt,
        })
        .from(webhookSubscriptions)
        .where(
          and(
            eq(webhookSubscriptions.workspaceId, scope.workspaceId ?? ""),
            eq(webhookSubscriptions.tenantId, scope.tenantId),
          ),
        )
        .orderBy(desc(webhookSubscriptions.createdAt)),
    ).then((rows) => rows.map((r) => ({ ...r, events: asStringArray(r.events) })));
  },

  /** The dispatch target (incl. the encrypted secret) for self-test/replay. Null when not in this workspace. */
  async getDispatchTarget(scope: TenantScope, id: string): Promise<WebhookDispatchTarget | null> {
    return withTenantTx(scope, async (tx) => {
      const rows = await tx
        .select({
          id: webhookSubscriptions.id,
          url: webhookSubscriptions.url,
          events: webhookSubscriptions.events,
          active: webhookSubscriptions.active,
          signingSecretEnc: webhookSubscriptions.signingSecretEnc,
        })
        .from(webhookSubscriptions)
        .where(
          and(
            eq(webhookSubscriptions.id, id),
            eq(webhookSubscriptions.workspaceId, scope.workspaceId ?? ""),
            eq(webhookSubscriptions.tenantId, scope.tenantId),
          ),
        )
        .limit(1);
      const row = rows[0];
      return row ? { ...row, events: asStringArray(row.events) } : null;
    });
  },

  /** Delete a subscription; returns true when a row in THIS workspace was removed (RLS + predicate). */
  async deleteSubscription(scope: TenantScope, id: string): Promise<boolean> {
    return withTenantTx(scope, async (tx) => {
      const deleted = await tx
        .delete(webhookSubscriptions)
        .where(
          and(
            eq(webhookSubscriptions.id, id),
            eq(webhookSubscriptions.workspaceId, scope.workspaceId ?? ""),
            eq(webhookSubscriptions.tenantId, scope.tenantId),
          ),
        )
        .returning({ id: webhookSubscriptions.id });
      return deleted.length > 0;
    });
  },

  /** Append one delivery-attempt row (self-test, replay, or a real dispatch). */
  async insertDelivery(scope: TenantScope, input: WebhookDeliveryInsert): Promise<string> {
    return withTenantTx(scope, async (tx) => {
      const inserted = await tx
        .insert(webhookDeliveries)
        .values(input)
        .returning({ id: webhookDeliveries.id });
      return inserted[0]!.id;
    });
  },

  /** Newest-first delivery log for the workspace. */
  async listDeliveries(scope: TenantScope, limit = 100): Promise<WebhookDeliveryRecord[]> {
    return withTenantTx(scope, (tx) =>
      tx
        .select({
          id: webhookDeliveries.id,
          webhookId: webhookDeliveries.webhookId,
          eventType: webhookDeliveries.eventType,
          status: webhookDeliveries.status,
          responseCode: webhookDeliveries.responseCode,
          attemptedAt: webhookDeliveries.attemptedAt,
        })
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.workspaceId, scope.workspaceId ?? ""),
            eq(webhookDeliveries.tenantId, scope.tenantId),
          ),
        )
        .orderBy(desc(webhookDeliveries.attemptedAt))
        .limit(limit),
    );
  },

  /** Re-hydrate one past delivery for replay (its event + payload + target). Null when not in this workspace. */
  async getDeliveryForReplay(
    scope: TenantScope,
    id: string,
  ): Promise<WebhookDeliveryForReplay | null> {
    return withTenantTx(scope, async (tx) => {
      const rows = await tx
        .select({
          id: webhookDeliveries.id,
          webhookId: webhookDeliveries.webhookId,
          eventType: webhookDeliveries.eventType,
          payload: webhookDeliveries.payload,
        })
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.id, id),
            eq(webhookDeliveries.workspaceId, scope.workspaceId ?? ""),
            eq(webhookDeliveries.tenantId, scope.tenantId),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    });
  },
};

/** Coerce the jsonb `events` column (typed `unknown` by drizzle) to a string[] defensively. */
function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
