// MappingEditor.tsx — the per-field sync policy editor (crm-sync 00 §4.3).
//
// This table is where a customer decides which of their fields TruePoint may write into their CRM, so the
// two controls that matter are DIRECTION and AUTHORITY:
//   - direction  — which way a field flows. `outbound` and `bidirectional` mean TruePoint writes into the
//                  customer's system of record, which is why changing it is an owner/admin action.
//   - authority  — who wins when both sides changed. `truepoint` means our value overwrites theirs.
//
// tpField and crmField are shown but NOT editable. Re-pointing which columns a mapping joins would silently
// re-describe history: the provenance already written under the old pair would then claim to be about a
// different field. Re-pointing is a delete-and-create, which is visible.
"use client";

import {
  type Column,
  DataTable,
  EmptyState,
  Icon,
  StateSwitch,
  TpSelect,
  TpSwitch,
} from "@leadwolf/ui";
import { ArrowLeftRight } from "lucide-react";
import styles from "../crm-sync.module.css";
import { useCrmMappings } from "../hooks/useCrmMappings";
import type { CrmMappingView } from "../types";

const DIRECTIONS = ["inbound", "outbound", "bidirectional", "disabled"];
const AUTHORITIES = ["crm", "truepoint"];

export function MappingEditor({ connectionId }: { connectionId: string | null }) {
  const { mappings, loading, error, saving, saveError, update, reload } =
    useCrmMappings(connectionId);
  const list = mappings ?? [];

  const columns: Column<CrmMappingView>[] = [
    { key: "object", header: "Object", sortValue: (m) => m.objectType, cell: (m) => m.objectType },
    {
      key: "tpField",
      header: "TruePoint field",
      sortValue: (m) => m.tpField,
      cell: (m) => m.tpField,
    },
    { key: "crmField", header: "CRM field", sortValue: (m) => m.crmField, cell: (m) => m.crmField },
    {
      key: "direction",
      header: "Direction",
      cell: (m) => (
        <TpSelect
          value={m.direction}
          disabled={saving}
          aria-label={`Direction for ${m.tpField}`}
          onChange={(e) => update(m.id, { direction: e.currentTarget.value })}
        >
          {DIRECTIONS.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </TpSelect>
      ),
    },
    {
      key: "authority",
      header: "Wins on conflict",
      cell: (m) => (
        <TpSelect
          value={m.authority}
          disabled={saving}
          aria-label={`Authority for ${m.tpField}`}
          onChange={(e) => update(m.id, { authority: e.currentTarget.value })}
        >
          {AUTHORITIES.map((a) => (
            <option key={a} value={a}>
              {a === "crm" ? "Your CRM" : "TruePoint"}
            </option>
          ))}
        </TpSelect>
      ),
    },
    {
      key: "enabled",
      header: "On",
      cell: (m) => (
        <TpSwitch
          checked={m.enabled}
          // A REQUIRED mapping cannot be switched off: the sync needs it to identify records at all, and
          // letting someone disable it would break matching in a way that looks like data loss.
          disabled={saving || m.isRequired}
          aria-label={`Enable ${m.tpField}`}
          onChange={(e) => update(m.id, { enabled: e.currentTarget.checked })}
        />
      ),
    },
  ];

  return (
    <StateSwitch
      loading={loading}
      error={error ?? saveError}
      onRetry={reload}
      empty={!loading && !error && list.length === 0}
      emptyState={
        <EmptyState
          icon={<Icon icon={ArrowLeftRight} size={28} />}
          title="No field mappings yet"
          description="Mappings are created when you connect a CRM. They control which fields sync, and which side wins when both change."
        />
      }
    >
      <div className={styles.stack}>
        <DataTable columns={columns} rows={list} rowKey={(m) => m.id} />
        <p className={styles.footnote}>
          Direction controls which way a field flows — outbound and bidirectional mean TruePoint
          writes into your CRM. "Wins on conflict" decides whose value survives when both sides
          changed; a field someone edited by hand is never overwritten either way, it goes to review
          instead.
        </p>
      </div>
    </StateSwitch>
  );
}
