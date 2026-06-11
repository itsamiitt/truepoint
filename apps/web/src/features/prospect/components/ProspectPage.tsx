// ProspectPage.tsx — the prospect surface (04 §5, 11 §4.2): a left filter rail, a center results grid of
// masked rows (name · title · company domain · email-status glyph · masked email · phone lock), and a right
// slide-over record detail opened by row click. The search endpoint is list-only at MVP, so the rail filters
// the loaded rows client-side (types.applyFilter). This is the feature's public component (rendered by the
// thin (shell)/prospect route). Composition + view state only — data + masking come from the slice.
"use client";

import type { MaskedContact } from "@leadwolf/types";
import { useMemo, useState } from "react";
import { useContacts } from "../hooks/useContacts";
import {
  EMPTY_FILTER,
  type ProspectFilter,
  applyFilter,
  displayName,
  emailGlyphFor,
  maskedEmail,
} from "../types";
import { RecordDetail } from "./RecordDetail";

function FilterRail({
  filter,
  onChange,
  total,
  shown,
}: {
  filter: ProspectFilter;
  onChange: (next: ProspectFilter) => void;
  total: number;
  shown: number;
}) {
  return (
    <aside className="tp-filter-rail" aria-label="Filters">
      <div className="tp-filter-field">
        <label className="tp-filter-label" htmlFor="tp-f-query">
          Search
        </label>
        <input
          id="tp-f-query"
          className="tp-input"
          type="search"
          placeholder="Title, name, department…"
          value={filter.query}
          onChange={(e) => onChange({ ...filter, query: e.target.value })}
        />
      </div>

      <div className="tp-filter-field">
        <label className="tp-filter-label" htmlFor="tp-f-seniority">
          Seniority
        </label>
        <select
          id="tp-f-seniority"
          className="tp-input"
          value={filter.seniority}
          onChange={(e) =>
            onChange({ ...filter, seniority: e.target.value as ProspectFilter["seniority"] })
          }
        >
          <option value="">Any seniority</option>
          <option value="c_suite">C-suite</option>
          <option value="vp">VP</option>
          <option value="director">Director</option>
          <option value="manager">Manager</option>
          <option value="ic">Individual contributor</option>
          <option value="other">Other</option>
        </select>
      </div>

      <label className="tp-filter-check">
        <input
          type="checkbox"
          checked={filter.hasEmail}
          onChange={(e) => onChange({ ...filter, hasEmail: e.target.checked })}
        />
        <span>Has email</span>
      </label>

      <button className="tp-link-quiet" type="button" onClick={() => onChange(EMPTY_FILTER)}>
        Clear filters
      </button>

      <p className="tp-filter-count">
        {shown} of {total} shown
      </p>
    </aside>
  );
}

function ResultRow({
  contact,
  selected,
  onSelect,
}: {
  contact: MaskedContact;
  selected: boolean;
  onSelect: () => void;
}) {
  const glyph = emailGlyphFor(contact);
  return (
    <tr
      className={`tp-result-row${selected ? " is-selected" : ""}`}
      onClick={onSelect}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <td className="tp-cell-name">{displayName(contact)}</td>
      <td>{contact.jobTitle ?? "—"}</td>
      <td className="tp-cell-mono">{contact.emailDomain ?? "—"}</td>
      <td className="tp-cell-center">
        <span
          className={`tp-glyph tp-glyph--${glyph.tone}`}
          title={glyph.label}
          aria-label={glyph.label}
        >
          {glyph.mark}
        </span>
      </td>
      <td className="tp-cell-mono">{maskedEmail(contact)}</td>
      <td className="tp-cell-center">
        {contact.hasPhone ? <span title="Phone hidden until reveal">🔒</span> : "—"}
      </td>
    </tr>
  );
}

export function ProspectPage() {
  const { contacts, error, loading, markRevealed } = useContacts();
  const [filter, setFilter] = useState<ProspectFilter>(EMPTY_FILTER);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filtered = useMemo(() => applyFilter(contacts, filter), [contacts, filter]);
  const selected = useMemo(
    () => contacts.find((c) => c.id === selectedId) ?? null,
    [contacts, selectedId],
  );

  return (
    <div className="tp-prospect">
      <FilterRail
        filter={filter}
        onChange={setFilter}
        total={contacts.length}
        shown={filtered.length}
      />

      <section className="tp-results">
        {error ? (
          <p className="lw-error">{error}</p>
        ) : loading ? (
          <p className="app-muted">Loading contacts…</p>
        ) : contacts.length === 0 ? (
          <p className="app-muted">
            No contacts yet — import a CSV from the Import surface to populate this workspace.
          </p>
        ) : filtered.length === 0 ? (
          <p className="app-muted">No contacts match these filters.</p>
        ) : (
          <table className="tp-result-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Title</th>
                <th>Company</th>
                <th className="tp-cell-center">Email</th>
                <th>Address</th>
                <th className="tp-cell-center">Phone</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <ResultRow
                  key={c.id}
                  contact={c}
                  selected={c.id === selectedId}
                  onSelect={() => setSelectedId(c.id)}
                />
              ))}
            </tbody>
          </table>
        )}
      </section>

      {selected && (
        <RecordDetail
          contact={selected}
          onClose={() => setSelectedId(null)}
          onRevealed={(id) => markRevealed(id)}
        />
      )}
    </div>
  );
}
