// LinksTable.tsx — the captured-links list (05 §5, M7): a DataTable of the workspace's saved Sales Navigator
// links with type, url, labels, note, captured-at, and a delete (confirmed via Dialog). All @leadwolf/ui kit +
// tokens; no hardcoded colors. The list/empty/loading/error states render through the State Kit for consistency.
"use client";

import type { SalesNavLinkDTO } from "@leadwolf/types";
import {
  type Column,
  DataTable,
  Dialog,
  EmptyState,
  StateSwitch,
  StatusBadge,
  TpButton,
  TpChip,
  TpIconButton,
  useToast,
} from "@leadwolf/ui";
import { Link2, Trash2 } from "lucide-react";
import { useState } from "react";
import { LINK_TYPE_LABELS } from "../types";

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function LinksTable({
  links,
  loading,
  error,
  onReload,
  onDelete,
}: {
  links: SalesNavLinkDTO[];
  loading: boolean;
  error: string | null;
  onReload: () => void;
  onDelete: (id: string) => Promise<void>;
}) {
  const { success, error: toastError } = useToast();
  const [pending, setPending] = useState<SalesNavLinkDTO | null>(null);
  const [removing, setRemoving] = useState(false);

  const confirmDelete = async () => {
    if (!pending) return;
    setRemoving(true);
    try {
      await onDelete(pending.id);
      success("Link removed");
      setPending(null);
    } catch (e) {
      toastError("Could not remove link", e instanceof Error ? e.message : undefined);
    } finally {
      setRemoving(false);
    }
  };

  const columns: Column<SalesNavLinkDTO>[] = [
    {
      key: "linkType",
      header: "Type",
      sortValue: (r) => LINK_TYPE_LABELS[r.linkType],
      cell: (r) => <StatusBadge tone="muted">{LINK_TYPE_LABELS[r.linkType]}</StatusBadge>,
      width: 140,
    },
    {
      key: "url",
      header: "Link",
      sortValue: (r) => r.url,
      cell: (r) => (
        <a
          href={r.url}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            color: "var(--tp-ink)",
            maxWidth: 360,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          <Link2 size={14} aria-hidden />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{r.url}</span>
        </a>
      ),
    },
    {
      key: "labels",
      header: "Labels",
      cell: (r) =>
        r.labels.length > 0 ? (
          <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
            {r.labels.map((l) => (
              <TpChip key={l}>{l}</TpChip>
            ))}
          </span>
        ) : (
          <span style={{ color: "var(--tp-ink-4)" }}>—</span>
        ),
    },
    {
      key: "note",
      header: "Note",
      cell: (r) =>
        r.note ? (
          <span
            title={r.note}
            style={{
              display: "inline-block",
              maxWidth: 240,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "var(--tp-ink-2)",
            }}
          >
            {r.note}
          </span>
        ) : (
          <span style={{ color: "var(--tp-ink-4)" }}>—</span>
        ),
    },
    {
      key: "capturedAt",
      header: "Captured",
      sortValue: (r) => r.capturedAt,
      cell: (r) => <span style={{ color: "var(--tp-ink-3)" }}>{formatDate(r.capturedAt)}</span>,
      width: 120,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: 56,
      cell: (r) => (
        <TpIconButton label="Remove link" onClick={() => setPending(r)}>
          <Trash2 size={15} aria-hidden />
        </TpIconButton>
      ),
    },
  ];

  return (
    <section className="lw-card">
      <h2>Captured links {loading ? "" : `(${links.length})`}</h2>
      <StateSwitch
        loading={loading}
        error={error}
        empty={links.length === 0}
        onRetry={onReload}
        emptyState={
          <EmptyState
            icon={<Link2 size={20} aria-hidden />}
            title="No captured links yet"
            description="Paste a Sales Navigator or LinkedIn URL above to save it to this workspace."
          />
        }
      >
        <DataTable columns={columns} rows={links} rowKey={(r) => r.id} />
      </StateSwitch>

      <Dialog
        open={pending !== null}
        onClose={() => (removing ? undefined : setPending(null))}
        title="Remove this link?"
        description="The captured link is deleted from this workspace. This can't be undone."
        footer={
          <>
            <TpButton variant="ghost" onClick={() => setPending(null)} disabled={removing}>
              Cancel
            </TpButton>
            <TpButton variant="danger" loading={removing} onClick={() => void confirmDelete()}>
              Remove
            </TpButton>
          </>
        }
      />
    </section>
  );
}
