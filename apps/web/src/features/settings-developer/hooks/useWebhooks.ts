// useWebhooks.ts — loads the tenant's webhook subscriptions (GET /webhooks) and the delivery log
// (GET /webhooks/deliveries) with loading/error + reload, plus create / remove mutators that refresh on success.
// Create returns the one-time signing secret to the caller (shown once). Presentation state only.
"use client";

import { useCallback, useEffect, useState } from "react";
import { createWebhook, deleteWebhook, fetchDeliveries, fetchWebhooks } from "../api";
import type { DeliveryFeed, WebhookEvent, WebhookSecret, WebhooksFeed } from "../types";

export function useWebhooks() {
  const [feed, setFeed] = useState<WebhooksFeed | null>(null);
  const [deliveries, setDeliveries] = useState<DeliveryFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [hooks, log] = await Promise.all([fetchWebhooks(), fetchDeliveries()]);
      setFeed(hooks);
      setDeliveries(log);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load webhooks");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = useCallback(
    async (url: string, events: WebhookEvent[]): Promise<WebhookSecret> => {
      const result = await createWebhook(url, events);
      if (result.ok) await reload();
      return result;
    },
    [reload],
  );

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      const { ok } = await deleteWebhook(id);
      if (ok) await reload();
      return ok;
    },
    [reload],
  );

  return { feed, deliveries, error, loading, reload, create, remove };
}
