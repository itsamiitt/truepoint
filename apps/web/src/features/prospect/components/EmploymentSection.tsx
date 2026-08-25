// EmploymentSection.tsx — career history from the graph, grouped by company (plan 33 · A2). [S-09] [S-13]
//
// WHAT THIS IS NOT: a timeline. That remains the governing decision, and for the same reason as before —
// the live import path mints a BARE employment edge (person, company, is_current, is_primary; no title, no
// dates), and a layout designed for rich stints renders a column of dashes against every row, which reads
// as broken rather than sparse.
//
// WHAT CHANGED: the rows are grouped by COMPANY rather than listed flat. `master_employment` is one row per
// (person, company, start), so a promotion is a second row at the same employer — and flat, that rendered as
// two unrelated entries with the company name printed twice and nothing tying them together. Grouping is not
// a richer layout; it is the same rows, arranged the way the data already describes them. A group of one
// bare edge still renders as one clean company line, so the honesty constraint is unchanged.
"use client";

import { EmploymentHistory } from "@/components/employment";
import { groupStints } from "@/lib/employment/groupEmployment";
import { EmptyState, StateSwitch } from "@leadwolf/ui";
import { Briefcase } from "lucide-react";
import { useMemo } from "react";
import { useContactEmployment } from "../hooks/useContactEmployment";

export function EmploymentSection({ contactId }: { contactId: string }) {
  const { stints, resolved, loading, error, reload } = useContactEmployment(contactId);

  // This path's wire shape is snake_case and carries department/confidence/source_count but no per-date
  // precision; the global path is camelCase and carries precision but no department. Both normalize to the
  // grouping util's input here, which is why one component can render either.
  const groups = useMemo(
    () =>
      groupStints(
        stints.map((s) => ({
          groupKey: s.group_key ?? null,
          companyName: s.company_name,
          title: s.title,
          department: s.department,
          isCurrent: s.is_current,
          isPrimary: s.is_primary,
          startedOn: s.started_on,
          endedOn: s.ended_on,
          startPrecision: null,
          endPrecision: null,
          confidence: s.confidence,
          sourceCount: s.source_count,
        })),
      ),
    [stints],
  );

  return (
    <StateSwitch
      loading={loading}
      error={error}
      empty={!loading && stints.length === 0}
      onRetry={reload}
      emptyState={
        <EmptyState
          icon={<Briefcase size={24} />}
          title={resolved ? "No employment on record" : "Not matched to the graph yet"}
          description={
            resolved
              ? "We hold no career history for this person."
              : "Employment appears once this contact is matched to the shared graph."
          }
        />
      }
    >
      <EmploymentHistory groups={groups} />
    </StateSwitch>
  );
}
