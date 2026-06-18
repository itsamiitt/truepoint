// WebhooksPanel.tsx — Developer ▸ Webhooks: subscribe to outbound events (reveal.completed / score.updated /
// outreach.status_changed / auth.event) with a signing secret shown once, a list of subscriptions, and a
// delivery-log DataTable (09 §10 — delivery log + retries). Empty-first against the unbuilt /webhooks API (M10);
// no fabricated deliveries, no fake secrets.
"use client";

import {
  type Column,
  DataTable,
  Dialog,
  EmptyState,
  FieldGroup,
  StateSwitch,
  StatusBadge,
  TpButton,
  TpCheckbox,
  TpInput,
  useToast,
} from "@leadwolf/ui";
import { Copy, RefreshCw, Send, Webhook as WebhookIcon } from "lucide-react";
import { useState } from "react";
import { useWebhooks } from "../hooks/useWebhooks";
import styles from "../settings-developer.module.css";
import {
  DELIVERY_LABEL,
  DELIVERY_TONE,
  EVENT_LABEL,
  EVENT_OPTIONS,
  type Webhook,
  type WebhookDelivery,
  type WebhookEvent,
} from "../types";

function formatDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export function WebhooksPanel() {
  const toast = useToast();
  const { feed, deliveries, loading, error, reload, create, remove, test, replay } = useWebhooks();

  const [subscribing, setSubscribing] = useState(false);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const [secret, setSecret] = useState<string | null>(null);
  const [toRemove, setToRemove] = useState<Webhook | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null); // a row mid-test/replay

  const notWired = () =>
    toast.toast({
      title: "Not available yet",
      description: "Webhook subscriptions connect once the API ships (M10).",
    });

  const toggleEvent = (event: WebhookEvent) =>
    setEvents((prev) =>
      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event],
    );

  const resetSubscribe = () => {
    setSubscribing(false);
    setUrl("");
    setEvents([]);
  };

  const onSubscribe = async () => {
    if (url.trim().length === 0 || events.length === 0) return;
    setSubmitting(true);
    try {
      const result = await create(url.trim(), events);
      if (!result.ok) {
        notWired();
        resetSubscribe();
        return;
      }
      resetSubscribe();
      toast.success("Webhook created");
      if (result.signingSecret) setSecret(result.signingSecret);
    } catch (e) {
      toast.error("Could not create the webhook", e instanceof Error ? e.message : undefined);
    } finally {
      setSubmitting(false);
    }
  };

  const onRemove = async () => {
    if (!toRemove) return;
    const ok = await remove(toRemove.id);
    if (ok) toast.success("Webhook removed");
    else notWired();
    setToRemove(null);
  };

  const describeResult = (status?: "succeeded" | "failed", code?: number | null): string =>
    status === "succeeded"
      ? `Endpoint responded ${code ?? "OK"}`
      : `Delivery failed${code != null ? ` (${code})` : ""}`;

  const onTest = async (w: Webhook) => {
    setBusyId(w.id);
    try {
      const result = await test(w.id);
      if (!result.ok) return notWired();
      if (result.status === "succeeded")
        toast.success("Test event delivered", describeResult(result.status, result.responseCode));
      else toast.error("Test event failed", describeResult(result.status, result.responseCode));
    } catch (e) {
      toast.error("Could not send the test event", e instanceof Error ? e.message : undefined);
    } finally {
      setBusyId(null);
    }
  };

  const onReplay = async (d: WebhookDelivery) => {
    setBusyId(d.id);
    try {
      const result = await replay(d.id);
      if (!result.ok) return notWired();
      if (result.status === "succeeded")
        toast.success("Delivery replayed", describeResult(result.status, result.responseCode));
      else toast.error("Replay failed", describeResult(result.status, result.responseCode));
    } catch (e) {
      toast.error("Could not replay the delivery", e instanceof Error ? e.message : undefined);
    } finally {
      setBusyId(null);
    }
  };

  const copySecret = async () => {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Could not copy", "Select the value and copy it manually.");
    }
  };

  const webhookColumns: Column<Webhook>[] = [
    {
      key: "url",
      header: "Endpoint",
      sortValue: (w) => w.url,
      cell: (w) => <span className={styles.mono}>{w.url}</span>,
    },
    {
      key: "events",
      header: "Events",
      cell: (w) => (
        <span className={styles.scopeTags}>
          {w.events.map((e) => (
            <StatusBadge key={e} tone="muted">
              {EVENT_LABEL[e]}
            </StatusBadge>
          ))}
        </span>
      ),
    },
    {
      key: "secret",
      header: "Secret",
      cell: (w) => <span className={styles.mono}>{w.secretPrefix ?? "—"}</span>,
    },
    {
      key: "status",
      header: "Status",
      cell: (w) => (
        <StatusBadge tone={w.active ? "success" : "muted"}>
          {w.active ? "Active" : "Paused"}
        </StatusBadge>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (w) => (
        <span className={styles.rowActions}>
          <TpButton
            variant="secondary"
            size="sm"
            leftIcon={<Send size={13} />}
            loading={busyId === w.id}
            disabled={busyId != null && busyId !== w.id}
            onClick={() => onTest(w)}
          >
            Test
          </TpButton>
          <TpButton variant="ghost" size="sm" onClick={() => setToRemove(w)}>
            Remove
          </TpButton>
        </span>
      ),
    },
  ];

  const deliveryColumns: Column<WebhookDelivery>[] = [
    {
      key: "event",
      header: "Event",
      sortValue: (d) => d.event,
      cell: (d) => (
        <span className={styles.mono}>{EVENT_LABEL[d.event as WebhookEvent] ?? d.event}</span>
      ),
    },
    {
      key: "outcome",
      header: "Outcome",
      cell: (d) => (
        <StatusBadge tone={DELIVERY_TONE[d.outcome]}>{DELIVERY_LABEL[d.outcome]}</StatusBadge>
      ),
    },
    {
      key: "code",
      header: "HTTP",
      align: "right",
      cell: (d) => <span className={styles.muted}>{d.status ?? "—"}</span>,
    },
    {
      key: "created",
      header: "When",
      sortValue: (d) => d.createdAt,
      cell: (d) => <span className={styles.muted}>{formatDate(d.createdAt)}</span>,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (d) => (
        <TpButton
          variant="ghost"
          size="sm"
          leftIcon={<RefreshCw size={13} />}
          loading={busyId === d.id}
          disabled={(busyId != null && busyId !== d.id) || d.webhookId == null}
          onClick={() => onReplay(d)}
        >
          Replay
        </TpButton>
      ),
    },
  ];

  return (
    <section>
      <div className={styles.panelHead}>
        <div className={styles.panelHeadText}>
          <h2 className={styles.panelTitle}>Webhooks</h2>
          <p className={styles.panelDesc}>
            Subscribe an endpoint to signed outbound events. Verify payloads with the signing secret
            shown once at creation.
          </p>
        </div>
        <TpButton leftIcon={<WebhookIcon size={15} />} onClick={() => setSubscribing(true)}>
          Add endpoint
        </TpButton>
      </div>

      {feed != null && !feed.available ? (
        <div className={styles.connectNote}>
          <span className={styles.connectNoteIcon}>
            <WebhookIcon size={15} />
          </span>
          <span>
            The webhooks backend isn&apos;t connected yet (M10). Subscriptions will appear here once
            it ships.
          </span>
        </div>
      ) : null}

      <StateSwitch
        loading={loading}
        error={error}
        empty={feed != null && feed.webhooks.length === 0}
        onRetry={reload}
        emptyState={
          <EmptyState
            icon={<WebhookIcon size={28} />}
            title={feed?.available ? "No webhooks yet" : "Webhooks not connected"}
            description={
              feed?.available
                ? "Add an endpoint to receive signed event notifications."
                : "Once the webhooks API ships, your subscriptions will appear here."
            }
            action={
              feed?.available ? (
                <TpButton size="sm" onClick={() => setSubscribing(true)}>
                  Add endpoint
                </TpButton>
              ) : undefined
            }
          />
        }
      >
        <DataTable columns={webhookColumns} rows={feed?.webhooks ?? []} rowKey={(w) => w.id} />
      </StateSwitch>

      {/* Delivery log */}
      <div className={styles.sectionGap}>
        <h3 className={styles.subTitle}>Delivery log</h3>
        <StateSwitch
          loading={loading}
          error={error}
          empty={deliveries != null && deliveries.deliveries.length === 0}
          onRetry={reload}
          emptyState={
            <EmptyState
              title={deliveries?.available ? "No deliveries yet" : "Delivery log not connected"}
              description={
                deliveries?.available
                  ? "Recent delivery attempts and retries will appear here."
                  : "Delivery attempts will be logged here once the webhooks API ships."
              }
            />
          }
        >
          <DataTable
            columns={deliveryColumns}
            rows={deliveries?.deliveries ?? []}
            rowKey={(d) => d.id}
          />
        </StateSwitch>
      </div>

      {/* Subscribe dialog */}
      <Dialog
        open={subscribing}
        onClose={resetSubscribe}
        title="Add webhook endpoint"
        description="Set the destination URL and choose which events to receive."
        footer={
          <>
            <TpButton variant="ghost" onClick={resetSubscribe}>
              Cancel
            </TpButton>
            <TpButton
              onClick={onSubscribe}
              loading={submitting}
              disabled={url.trim().length === 0 || events.length === 0}
            >
              Create
            </TpButton>
          </>
        }
      >
        <div className={styles.dialogForm}>
          <FieldGroup label="Endpoint URL" htmlFor="hook-url">
            <TpInput
              id="hook-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/webhooks/truepoint"
            />
          </FieldGroup>
          <FieldGroup label="Events">
            <div className={styles.eventList}>
              {EVENT_OPTIONS.map((ev) => (
                <div key={ev.value} className={styles.eventRow}>
                  <TpCheckbox
                    label={ev.label}
                    checked={events.includes(ev.value)}
                    onChange={() => toggleEvent(ev.value)}
                  />
                  <span className={styles.scopeDesc}>{ev.description}</span>
                </div>
              ))}
            </div>
          </FieldGroup>
        </div>
      </Dialog>

      {/* One-time signing secret */}
      <Dialog
        open={secret != null}
        onClose={() => setSecret(null)}
        title="Your signing secret"
        description="Use this to verify webhook payload signatures. It's shown only once."
        footer={<TpButton onClick={() => setSecret(null)}>Done</TpButton>}
      >
        <div className={styles.secretBox}>
          <p className={styles.secretWarn}>
            Store this secret securely — it won&apos;t be shown again.
          </p>
          <div className={styles.secretRow}>
            <code className={styles.secretValue}>{secret}</code>
            <TpButton variant="secondary" leftIcon={<Copy size={14} />} onClick={copySecret}>
              Copy
            </TpButton>
          </div>
        </div>
      </Dialog>

      {/* Remove confirm */}
      <Dialog
        open={toRemove != null}
        onClose={() => setToRemove(null)}
        title="Remove webhook?"
        description={toRemove ? `${toRemove.url} will stop receiving events.` : undefined}
        footer={
          <>
            <TpButton variant="ghost" onClick={() => setToRemove(null)}>
              Cancel
            </TpButton>
            <TpButton variant="danger" onClick={onRemove}>
              Remove
            </TpButton>
          </>
        }
      />
    </section>
  );
}
