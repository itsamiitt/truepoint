// useWebhooks.ts — the tenant's webhook endpoints and their recent delivery log, plus create / remove /
// self-test ping / replay (which re-POSTs a past delivery with a fresh signature). Presentation state only.
//
// The endpoints and the delivery log are SEPARATE queries. They were one combined load, which meant the
// delivery-log refresh a test or replay needs also re-fetched the endpoint list that had not changed — and,
// more to the point, a slow delivery log delayed rendering the endpoints. Each action now invalidates only
// what it actually affects.
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createWebhook,
  deleteWebhook,
  fetchDeliveries,
  fetchWebhooks,
  replayDelivery,
  testWebhook,
} from "../api";
import { settingsDeveloperKeys } from "../keys";
import type {
  DeliveryFeed,
  WebhookEvent,
  WebhookSecret,
  WebhookTestResult,
  WebhooksFeed,
} from "../types";

export function useWebhooks() {
  const qc = useQueryClient();
  const hooksKey = settingsDeveloperKeys.webhooks();
  const deliveriesKey = settingsDeveloperKeys.webhookDeliveries();

  const hooks = useQuery<WebhooksFeed>({ queryKey: hooksKey, queryFn: fetchWebhooks });
  const deliveries = useQuery<DeliveryFeed>({ queryKey: deliveriesKey, queryFn: fetchDeliveries });

  const invalidate = (keys: readonly (readonly string[])[]) => {
    for (const queryKey of keys) void qc.invalidateQueries({ queryKey });
  };

  const create = useMutation({
    mutationFn: (vars: { url: string; events: WebhookEvent[] }) =>
      createWebhook(vars.url, vars.events),
    // A new endpoint changes the list; it has not delivered anything yet.
    onSuccess: ({ ok }) => ok && invalidate([hooksKey]),
  });
  const remove = useMutation({
    mutationFn: deleteWebhook,
    onSuccess: ({ ok }) => ok && invalidate([hooksKey]),
  });
  // A self-test and a replay both APPEND a delivery-log row and leave the endpoint list alone.
  const test = useMutation({
    mutationFn: testWebhook,
    onSuccess: ({ ok }) => ok && invalidate([deliveriesKey]),
  });
  const replay = useMutation({
    mutationFn: replayDelivery,
    onSuccess: ({ ok }) => ok && invalidate([deliveriesKey]),
  });

  const error = hooks.error ?? deliveries.error;

  return {
    feed: hooks.data ?? null,
    deliveries: deliveries.data ?? null,
    error: error ? (error instanceof Error ? error.message : "Failed to load webhooks") : null,
    loading: hooks.isPending || deliveries.isPending,
    reload: () => {
      void hooks.refetch();
      void deliveries.refetch();
    },
    create: (url: string, events: WebhookEvent[]): Promise<WebhookSecret> =>
      create.mutateAsync({ url, events }),
    remove: async (id: string): Promise<boolean> => (await remove.mutateAsync(id)).ok,
    test: (id: string): Promise<WebhookTestResult> => test.mutateAsync(id),
    replay: (id: string): Promise<WebhookTestResult> => replay.mutateAsync(id),
  };
}
