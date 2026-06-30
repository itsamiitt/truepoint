// TenantHolds.tsx — the abuse/fraud holds panel on a tenant's detail (13a Area 7, 13 §3.7): the active holds
// (with a Lift action) and the history, plus a place-hold form. A hold is the abuse-review flag, distinct from
// suspend. Reads/writes the audited /admin/tenants/:id/holds surface; place/lift need the tenants:hold
// capability (the buttons hide otherwise; the api still enforces it). Staff-only — never shown to the customer.
"use client";

import { useStaffMe } from "@/lib/staffMe";
import { accountHoldKind } from "@leadwolf/types";
import {
  Card,
  StateSwitch,
  StatusBadge,
  TpButton,
  TpSelect,
  TpTextarea,
  useToast,
} from "@leadwolf/ui";
import { useCallback, useEffect, useState } from "react";
import { fetchTenantHolds, liftTenantHold, placeTenantHold } from "../api";
import { shortDate } from "../format";
import type { AccountHold } from "../types";

// Derive the kind options from the canonical @leadwolf/types enum so the form never drifts from the api/db.
const HOLD_KINDS = accountHoldKind.options;
const MIN_REASON = 5;

export function TenantHolds({ tenantId }: { tenantId: string }) {
  const toast = useToast();
  const { canMaybe } = useStaffMe();
  const canManage = canMaybe("tenants:hold");

  const [holds, setHolds] = useState<AccountHold[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<string>("fraud");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setHolds(await fetchTenantHolds(tenantId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load holds");
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function onPlace() {
    const r = reason.trim();
    if (r.length < MIN_REASON) {
      toast.error(`Enter a reason (min ${MIN_REASON} characters).`);
      return;
    }
    setBusy(true);
    try {
      await placeTenantHold(tenantId, kind, r);
      toast.success("Hold placed.");
      setReason("");
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not place the hold");
    } finally {
      setBusy(false);
    }
  }

  async function onLift(hold: AccountHold) {
    try {
      await liftTenantHold(tenantId, hold.id);
      toast.success("Hold lifted.");
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not lift the hold");
    }
  }

  const activeCount = (holds ?? []).filter((h) => h.liftedAt == null).length;

  return (
    <div style={{ marginTop: 28 }}>
      <h3 className="tp-section-title">
        Account holds
        {activeCount > 0 ? (
          <>
            {" "}
            · <StatusBadge tone="danger">{activeCount} active</StatusBadge>
          </>
        ) : null}
      </h3>

      {canManage ? (
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "flex-end",
            flexWrap: "wrap",
            margin: "8px 0 16px",
            maxWidth: 640,
          }}
        >
          <label htmlFor="hold-kind" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>Kind</span>
            <TpSelect
              id="hold-kind"
              value={kind}
              disabled={busy}
              onChange={(e) => setKind(e.currentTarget.value)}
            >
              {HOLD_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </TpSelect>
          </label>
          <label
            htmlFor="hold-reason"
            style={{ display: "flex", flexDirection: "column", gap: 4, flex: "1 1 280px" }}
          >
            <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>Reason (audited)</span>
            <TpTextarea
              id="hold-reason"
              value={reason}
              rows={2}
              placeholder="Why is this org being held?"
              disabled={busy}
              onChange={(e) => setReason(e.currentTarget.value)}
            />
          </label>
          <TpButton variant="danger" onClick={() => void onPlace()} disabled={busy}>
            {busy ? "Placing…" : "Place hold"}
          </TpButton>
        </div>
      ) : null}

      <StateSwitch
        loading={loading}
        error={error}
        empty={!!holds && holds.length === 0}
        onRetry={() => void reload()}
        emptyState={
          <p className="app-muted" style={{ padding: 16 }}>
            No holds on this org.
          </p>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 640 }}>
          {(holds ?? []).map((h) => {
            const active = h.liftedAt == null;
            return (
              <Card key={h.id}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <div>
                    <StatusBadge tone={active ? "danger" : "muted"}>
                      {active ? h.kind : `${h.kind} · lifted`}
                    </StatusBadge>
                    <div style={{ marginTop: 6, whiteSpace: "pre-wrap", color: "var(--tp-ink)" }}>
                      {h.reason}
                    </div>
                    <div
                      className="tp-cell-mono"
                      style={{ marginTop: 6, fontSize: 12, color: "var(--tp-ink-3)" }}
                    >
                      placed {shortDate(h.placedAt)} · {h.placedByUserId.slice(0, 8)}
                      {h.liftedAt ? ` · lifted ${shortDate(h.liftedAt)}` : ""}
                    </div>
                  </div>
                  {active && canManage ? (
                    <TpButton variant="ghost" size="sm" onClick={() => void onLift(h)}>
                      Lift
                    </TpButton>
                  ) : null}
                </div>
              </Card>
            );
          })}
        </div>
      </StateSwitch>
    </div>
  );
}
