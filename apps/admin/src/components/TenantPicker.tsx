"use client";
// TenantPicker.tsx — an async typeahead that resolves a tenant by name/slug to its id, so staff stop pasting
// raw UUIDs on surfaces that target a single org (announcements, feature-flag overrides, …). It searches the
// audited GET /admin/tenants?search= endpoint server-side (ILIKE, keyset-bounded), DEBOUNCED — so it scales
// past any one page, unlike a client-filtered static list. Controlled: `value` is the selected tenant id
// (""=none); `onChange(id, name)` fires on select. Token-styled with the shared tp-ui popover classes
// (primitives.css), closes on outside-click + Esc. UX/convenience only — the api still validates + authorizes
// the id on the write, so a hand-typed or stale value can never bypass a check.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import { useEffect, useRef, useState } from "react";

interface TenantHit {
  id: string;
  name: string;
  slug: string;
}

async function searchTenants(query: string): Promise<TenantHit[]> {
  const qs = query ? `?search=${encodeURIComponent(query)}` : "";
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/tenants${qs}`);
  if (!res.ok) return [];
  const body = (await res.json()) as { tenants?: TenantHit[] };
  return (body.tenants ?? []).slice(0, 10);
}

export function TenantPicker({
  id,
  value,
  selectedName,
  onChange,
  disabled,
  placeholder = "Search tenants by name…",
}: {
  /** Optional input id so a wrapping <label htmlFor> can associate; also seeds the listbox id. */
  id?: string;
  /** The selected tenant id, or "" when none is chosen yet. */
  value: string;
  /** Display name of the selected tenant when known (e.g. just picked); falls back to the id otherwise. */
  selectedName?: string | null;
  onChange: (tenantId: string, tenantName: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<TenantHit[]>([]);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const listId = id ? `${id}-list` : undefined;

  // Debounced server search while the dropdown is open (250ms; cancels in-flight on each keystroke/close).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      void (async () => {
        const rows = await searchTenants(query.trim());
        if (!cancelled) {
          setHits(rows);
          setLoading(false);
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, open]);

  // Close on outside-click + Esc (mirrors the kit Combobox).
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const showChip = !!value && !open;

  return (
    <div className="tp-ui-anchor" ref={ref} style={{ display: "block" }}>
      {showChip ? (
        <button
          type="button"
          className="tp-ui-field"
          disabled={disabled}
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            textAlign: "left",
          }}
          onClick={() => setOpen(true)}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {selectedName ?? `Tenant ${value.slice(0, 8)}…`}
          </span>
          <span aria-hidden style={{ color: "var(--tp-ink-4)", marginLeft: 8 }}>
            ▾
          </span>
        </button>
      ) : (
        <input
          id={id}
          className="tp-ui-field"
          value={query}
          placeholder={placeholder}
          disabled={disabled}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
        />
      )}
      {open ? (
        <div
          id={listId}
          className="tp-ui-popover tp-ui-popover--start"
          style={{ width: "100%", maxHeight: 280, overflow: "auto" }}
        >
          <div className="tp-ui-menu">
            {loading ? (
              <div style={{ padding: "8px 10px", color: "var(--tp-ink-4)", fontSize: 13 }}>
                Searching…
              </div>
            ) : hits.length === 0 ? (
              <div style={{ padding: "8px 10px", color: "var(--tp-ink-4)", fontSize: 13 }}>
                No tenants match.
              </div>
            ) : (
              hits.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="tp-ui-menu-item"
                  onClick={() => {
                    onChange(t.id, t.name);
                    setQuery("");
                    setOpen(false);
                  }}
                >
                  <span style={{ flex: 1 }}>{t.name}</span>
                  <span style={{ color: "var(--tp-ink-4)", fontSize: 12 }}>{t.slug}</span>
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
