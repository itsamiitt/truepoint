// SupportNotes.tsx — the staff support-notes panel on a tenant's detail (13a Area 3, 13 §3.3): a newest-first
// list of internal notes plus an add form (body + optional ticket link). Reads/writes the audited,
// support-gated /admin/tenants/:id/notes surface; a 403 from the api is surfaced as a clear toast. Staff-only
// data — never shown to the customer. Renders async state through the shared State Kit.
"use client";

import { Card, StateSwitch, TpButton, TpInput, TpTextarea, useToast } from "@leadwolf/ui";
import { useCallback, useEffect, useState } from "react";
import { addTenantNote, fetchTenantNotes } from "../api";
import { shortDate } from "../format";
import type { SupportNote } from "../types";

export function SupportNotes({ tenantId }: { tenantId: string }) {
  const toast = useToast();
  const [notes, setNotes] = useState<SupportNote[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [body, setBody] = useState("");
  const [ticketUrl, setTicketUrl] = useState("");
  const [adding, setAdding] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setNotes(await fetchTenantNotes(tenantId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load notes");
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function onAdd() {
    const b = body.trim();
    if (!b) {
      toast.error("Enter a note.");
      return;
    }
    setAdding(true);
    try {
      await addTenantNote(tenantId, b, ticketUrl.trim() || undefined);
      toast.success("Note added.");
      setBody("");
      setTicketUrl("");
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add note");
    } finally {
      setAdding(false);
    }
  }

  return (
    <div style={{ marginTop: 28 }}>
      <h3 className="tp-section-title">Support notes</h3>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          margin: "8px 0 16px",
          maxWidth: 640,
        }}
      >
        <TpTextarea
          value={body}
          rows={2}
          placeholder="Add an internal note…"
          aria-label="Note body"
          disabled={adding}
          onChange={(e) => setBody(e.currentTarget.value)}
        />
        <div style={{ display: "flex", gap: 8 }}>
          <TpInput
            value={ticketUrl}
            placeholder="Ticket URL (optional)"
            aria-label="Ticket URL"
            disabled={adding}
            onChange={(e) => setTicketUrl(e.currentTarget.value)}
          />
          <TpButton onClick={() => void onAdd()} disabled={adding}>
            {adding ? "Adding…" : "Add note"}
          </TpButton>
        </div>
      </div>

      <StateSwitch
        loading={loading}
        error={error}
        empty={!!notes && notes.length === 0}
        onRetry={() => void reload()}
        emptyState={
          <p className="app-muted" style={{ padding: 16 }}>
            No support notes yet.
          </p>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 640 }}>
          {(notes ?? []).map((n) => (
            <Card key={n.id}>
              <div style={{ whiteSpace: "pre-wrap", color: "var(--tp-ink)" }}>{n.body}</div>
              <div
                className="tp-cell-mono"
                style={{ marginTop: 6, fontSize: 12, color: "var(--tp-ink-3)" }}
              >
                {shortDate(n.createdAt)} · {n.staffUserId.slice(0, 8)}
                {n.ticketUrl ? (
                  <>
                    {" · "}
                    <a href={n.ticketUrl} target="_blank" rel="noreferrer">
                      ticket
                    </a>
                  </>
                ) : null}
              </div>
            </Card>
          ))}
        </div>
      </StateSwitch>
    </div>
  );
}
