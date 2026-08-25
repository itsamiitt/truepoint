// DataSourceOriginsPage.tsx — the origin-fleet console for the linkedin_api data source (provider_origins,
// 0117; docs/planning/linkedin-source-ingestion/ §origins). A DataTable of origins in FAILOVER order:
// priority, paused switch, masked key hint, passive health (consecutive failures / last ok / last error),
// a live test probe (status+latency only), and an add-origin form. The API key is write-only — entered
// here once, sealed server-side, never displayed again (the provider-configs masked-secret posture, real).
"use client";

import { useStaffMe } from "@/lib/staffMe";
import {
  type Column,
  DataTable,
  EmptyState,
  PageContainer,
  PageHeader,
  StateSwitch,
  StatusBadge,
  type StatusTone,
  TableSkeleton,
  TpButton,
  TpInput,
  TpSwitch,
  useToast,
} from "@leadwolf/ui";
import { KeyRound, Plug } from "lucide-react";
import { useState } from "react";
import { createOrigin, deleteOrigin, setOriginPaused, testOrigin } from "../api";
import { useDataSourceOrigins } from "../hooks/useDataSourceOrigins";
import type { DataSourceOriginView } from "../types";

function healthTone(o: DataSourceOriginView): StatusTone {
  if (o.paused) return "muted";
  if (o.consecutiveFailures >= 3) return "danger";
  if (o.consecutiveFailures > 0) return "warning";
  return o.lastOkAt ? "success" : "muted";
}

function healthLabel(o: DataSourceOriginView): string {
  if (o.paused) return "paused";
  if (o.consecutiveFailures > 0) return `${o.consecutiveFailures} failing`;
  return o.lastOkAt ? "healthy" : "untested";
}

export function DataSourceOriginsPage() {
  const { origins, error, unavailable, loading, reload } = useDataSourceOrigins();
  const toast = useToast();
  const { canMaybe } = useStaffMe();
  const canManage = canMaybe("providers:manage");
  const [busy, setBusy] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [priority, setPriority] = useState("100");

  async function run(id: string, fn: () => Promise<void>, ok: string) {
    setBusy(id);
    try {
      await fn();
      toast.success(ok);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  async function add() {
    const prio = Number.parseInt(priority, 10);
    await run(
      "add",
      async () => {
        await createOrigin({
          label: label.trim(),
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim() ? apiKey.trim() : null,
          priority: Number.isFinite(prio) ? prio : undefined,
        });
        setLabel("");
        setBaseUrl("");
        setApiKey("");
        setPriority("100");
      },
      "Origin added",
    );
  }

  async function probe(o: DataSourceOriginView) {
    setBusy(o.id);
    try {
      const r = await testOrigin(o.id);
      if (r.status === "ok") toast.success(`OK in ${r.latencyMs}ms`);
      else if (r.status === "rejected") toast.error(`Vendor rejected (HTTP ${r.httpStatus})`);
      else toast.error(`Unavailable after ${r.latencyMs}ms`);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Test failed");
    } finally {
      setBusy(null);
    }
  }

  const columns: Column<DataSourceOriginView>[] = [
    {
      key: "label",
      header: "Origin",
      sortValue: (o) => o.priority,
      cell: (o) => (
        <span style={{ display: "inline-flex", flexDirection: "column" }}>
          <span style={{ fontWeight: 600 }}>{o.label}</span>
          <span style={{ fontSize: "var(--tp-text-caption)", fontFamily: "var(--font-mono)" }}>
            {o.baseUrl}
          </span>
        </span>
      ),
    },
    {
      key: "priority",
      header: "Priority",
      align: "right",
      width: 90,
      sortValue: (o) => o.priority,
      cell: (o) => o.priority,
    },
    {
      key: "active",
      header: "Active",
      align: "center",
      width: 90,
      cell: (o) => (
        <TpSwitch
          checked={!o.paused}
          disabled={busy === o.id || !canManage}
          aria-label={`Toggle ${o.label}`}
          onChange={(e) =>
            void run(o.id, () => setOriginPaused(o.id, !e.currentTarget.checked), "Updated")
          }
        />
      ),
    },
    {
      key: "key",
      header: "API key",
      width: 130,
      cell: (o) => (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: "var(--tp-text-caption)",
          }}
        >
          <KeyRound size={13} aria-hidden />
          <span style={{ fontFamily: "var(--font-mono)" }}>{o.apiKeyHint ?? "not set"}</span>
        </span>
      ),
    },
    {
      key: "health",
      header: "Health",
      width: 130,
      cell: (o) => (
        <span title={o.lastError ?? undefined}>
          <StatusBadge tone={healthTone(o)}>{healthLabel(o)}</StatusBadge>
        </span>
      ),
    },
    {
      key: "lastOk",
      header: "Last OK",
      width: 150,
      cell: (o) => (o.lastOkAt ? new Date(o.lastOkAt).toLocaleString() : "—"),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: 170,
      cell: (o) => (
        <span style={{ display: "inline-flex", gap: 6 }}>
          <TpButton
            variant="ghost"
            size="sm"
            disabled={busy === o.id || !canManage}
            onClick={() => void probe(o)}
          >
            Test
          </TpButton>
          <TpButton
            variant="ghost"
            size="sm"
            disabled={busy === o.id || !canManage}
            onClick={() => void run(o.id, () => deleteOrigin(o.id), "Origin deleted")}
          >
            Delete
          </TpButton>
        </span>
      ),
    },
  ];

  return (
    <PageContainer width="fluid">
      <PageHeader
        title="Data sources — linkedin_api origins"
        subtitle="Failover chain, priority ascending. Keys are sealed on save and never shown again. Pausing an origin takes effect fleet-wide within a minute."
      />

      {canManage && !unavailable ? (
        <div
          style={{
            display: "flex",
            gap: "var(--tp-space-2)",
            alignItems: "flex-end",
            flexWrap: "wrap",
            marginBottom: "var(--tp-space-4)",
          }}
        >
          <TpInput
            aria-label="Label"
            placeholder="Label (e.g. data)"
            value={label}
            onChange={(e) => setLabel(e.currentTarget.value)}
          />
          <TpInput
            aria-label="Base URL"
            placeholder="https://data.truepoint.in"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.currentTarget.value)}
            style={{ minWidth: 260 }}
          />
          <TpInput
            aria-label="API key (write-only)"
            placeholder="API key (write-only)"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.currentTarget.value)}
          />
          <TpInput
            aria-label="Priority"
            placeholder="Priority"
            value={priority}
            onChange={(e) => setPriority(e.currentTarget.value)}
            style={{ width: 90 }}
          />
          <TpButton
            variant="primary"
            size="sm"
            disabled={busy === "add" || !label.trim() || !baseUrl.trim()}
            onClick={() => void add()}
          >
            Add origin
          </TpButton>
        </div>
      ) : null}

      <StateSwitch
        loading={loading}
        error={error}
        empty={unavailable || origins.length === 0}
        onRetry={() => void reload()}
        skeleton={
          <TableSkeleton rows={5} columns={[14, 4, 4, 6, 6, 7, 7]} label="Loading origins" />
        }
        emptyState={
          unavailable ? (
            <EmptyState
              icon={<Plug size={24} />}
              title="Data sources not available"
              description="The /admin/data-sources endpoint is not mounted in this environment."
            />
          ) : (
            <EmptyState
              icon={<Plug size={24} />}
              title="No origins registered"
              description="The linkedin_api fleet is dark until an origin is added (env fallback aside)."
            />
          )
        }
      >
        <DataTable columns={columns} rows={origins} rowKey={(o) => o.id} />
      </StateSwitch>
    </PageContainer>
  );
}
