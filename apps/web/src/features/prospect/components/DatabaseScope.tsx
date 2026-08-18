// DatabaseScope.tsx — the "Database" scope of the Prospect surface (Layer-0-as-database slice 2): search
// everyone the platform holds, then add the ones you want into your workspace. Sibling of the Contacts and
// Accounts scopes; owns its own URL-derived query (useDatabaseSearch) and the add mutation.
"use client";

import type { DatabaseFilter, MaskedDatabasePerson } from "@leadwolf/types";
import { EmptyState, StateSwitch, TpButton, TpChip, TpInput, useToast } from "@leadwolf/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Database } from "lucide-react";
import { useState } from "react";
import { addFromDatabase } from "../databaseSearchApi";
import { useDatabaseSearch } from "../hooks/useDatabaseSearch";
import styles from "../prospect.module.css";
import { DatabaseTable } from "./DatabaseTable";

const SENIORITY: Array<{ value: string; label: string }> = [
  { value: "c_suite", label: "C-suite" },
  { value: "vp", label: "VP" },
  { value: "director", label: "Director" },
  { value: "manager", label: "Manager" },
  { value: "ic", label: "IC" },
];

/** Read the single value of a term filter (the panel keeps one value per field). */
function termValue(filters: DatabaseFilter[], field: string): string {
  const f = filters.find((x) => x.kind === "term" && x.field === field);
  return f && f.kind === "term" ? (f.values[0] ?? "") : "";
}
function boolValue(filters: DatabaseFilter[], field: string): boolean {
  const f = filters.find((x) => x.kind === "bool" && x.field === field);
  return f?.kind === "bool" ? f.value : false;
}

export function DatabaseScope() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { query, setQuery, hits, total, loading, error, hasMore, loadMore, reload } =
    useDatabaseSearch();
  const [adding, setAdding] = useState<string | null>(null);

  const setTerm = (field: "title" | "company" | "location", value: string) => {
    const rest = query.filters.filter((f) => !(f.kind === "term" && f.field === field));
    setQuery({
      ...query,
      filters: value.trim() ? [...rest, { kind: "term", field, values: [value.trim()] }] : rest,
    });
  };
  const toggleSeniority = (value: string) => {
    const current = query.filters.find((f) => f.kind === "term" && f.field === "seniority");
    const values = current?.kind === "term" ? current.values : [];
    const next = values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
    const rest = query.filters.filter((f) => !(f.kind === "term" && f.field === "seniority"));
    setQuery({
      ...query,
      filters:
        next.length > 0 ? [...rest, { kind: "term", field: "seniority", values: next }] : rest,
    });
  };
  const toggleBool = (field: "has_email" | "has_phone") => {
    const on = boolValue(query.filters, field);
    const rest = query.filters.filter((f) => !(f.kind === "bool" && f.field === field));
    setQuery({ ...query, filters: on ? rest : [...rest, { kind: "bool", field, value: true }] });
  };

  const onAdd = async (person: MaskedDatabasePerson) => {
    setAdding(person.linkedinPublicId);
    try {
      const res = await addFromDatabase(person.linkedinPublicId);
      if (res.contactId) {
        toast.success(`Added ${person.fullName ?? "contact"} to your workspace`);
        // The workspace now holds this person: refresh the database grid's "In workspace" flags AND every
        // contact surface (the new row must appear in Contacts without a manual reload).
        void queryClient.invalidateQueries({ queryKey: ["prospect"] });
      } else {
        toast.error("Could not add this contact", res.reason);
      }
    } catch (e) {
      toast.error("Could not add this contact", e instanceof Error ? e.message : undefined);
    } finally {
      setAdding(null);
    }
  };

  const seniorityValues =
    query.filters.find((f) => f.kind === "term" && f.field === "seniority")?.kind === "term"
      ? (
          query.filters.find((f) => f.kind === "term" && f.field === "seniority") as {
            values: string[];
          }
        ).values
      : [];

  return (
    <div className={styles.databaseScope}>
      <div className={styles.databaseFilters}>
        <TpInput
          placeholder="Search the TruePoint database — name, title, company"
          defaultValue={query.text ?? ""}
          onBlur={(e) => setQuery({ ...query, text: e.currentTarget.value || undefined })}
          onKeyDown={(e) => {
            if (e.key === "Enter") setQuery({ ...query, text: e.currentTarget.value || undefined });
          }}
        />
        <TpInput
          placeholder="Job title"
          defaultValue={termValue(query.filters, "title")}
          onBlur={(e) => setTerm("title", e.currentTarget.value)}
        />
        <TpInput
          placeholder="Company"
          defaultValue={termValue(query.filters, "company")}
          onBlur={(e) => setTerm("company", e.currentTarget.value)}
        />
        <TpInput
          placeholder="Location"
          defaultValue={termValue(query.filters, "location")}
          onBlur={(e) => setTerm("location", e.currentTarget.value)}
        />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {SENIORITY.map((s) => (
            <TpChip
              key={s.value}
              active={seniorityValues.includes(s.value)}
              onClick={() => toggleSeniority(s.value)}
            >
              {s.label}
            </TpChip>
          ))}
          <TpChip
            active={boolValue(query.filters, "has_email")}
            onClick={() => toggleBool("has_email")}
          >
            Has email
          </TpChip>
          <TpChip
            active={boolValue(query.filters, "has_phone")}
            onClick={() => toggleBool("has_phone")}
          >
            Has phone
          </TpChip>
        </div>
      </div>

      <div className={styles.resultsHead}>
        <span className={styles.count}>
          {loading
            ? "Searching…"
            : total !== undefined
              ? `${total.toLocaleString()} people`
              : `${hits.length.toLocaleString()}${hasMore ? "+" : ""} people`}
        </span>
      </div>

      <StateSwitch
        loading={loading}
        error={error}
        empty={!loading && hits.length === 0}
        onRetry={() => reload()}
        emptyState={
          <EmptyState
            icon={<Database size={20} />}
            title="No matches yet"
            description="Try a broader search. The database grows as your team browses and captures prospects."
          />
        }
      >
        <DatabaseTable people={hits} adding={adding} onAdd={onAdd} />
        {hasMore ? (
          <div style={{ display: "flex", justifyContent: "center", padding: 12 }}>
            <TpButton variant="secondary" onClick={loadMore}>
              Load more
            </TpButton>
          </div>
        ) : null}
      </StateSwitch>
    </div>
  );
}
