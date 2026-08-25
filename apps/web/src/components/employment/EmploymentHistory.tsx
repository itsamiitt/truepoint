// EmploymentHistory.tsx — employment history the way a professional profile shows it: one block per
// COMPANY, with the roles held there listed underneath. [S-09] [S-13] [A-01]
//
// WHAT CHANGED AND WHY. `master_employment` is one row per (person, company, start), so a promotion is a
// second row at the same company. Every surface rendered those rows FLAT, so someone promoted from Finance
// Manager to Finance Director at Acme read as two unrelated entries with "Acme" printed twice and nothing
// saying it was one continuous tenure. The grouping is in lib/employment (pure, unit-tested); this file is
// only how a group looks.
//
// Pure props — no fetching, no feature imports — so both callers (the owned-contact drawer and the global
// profile drawer, whose wire contracts differ in case and in which extras they carry) render identically
// from the same normalized shape.
"use client";

import type { CompanyGroup, EmploymentRole } from "@/lib/employment/groupEmployment";
import { StatusBadge } from "@leadwolf/ui";
import styles from "./employment.module.css";

/** A single letter stands in for a logo — we hold none per position, and inventing one would assert more
 *  than the record carries. */
function monogram(name: string | null): string {
  return name?.trim()[0]?.toUpperCase() ?? "?";
}

function join(parts: Array<string | null | undefined>): string | null {
  const out = parts.filter((p): p is string => Boolean(p?.trim())).join(" · ");
  return out.length > 0 ? out : null;
}

function Role({ role, showBadge }: { role: EmploymentRole; showBadge: boolean }) {
  // Built from whatever the row actually has rather than a fixed template, so a sparse stint renders a
  // clean short line instead of a row of em-dashes (planning doc 33 §A2).
  const meta = join([
    role.dateRange,
    role.duration,
    role.department,
    role.location,
    // Provenance where the path carries it [A-01] — the owned-contact read ships it, the global one does not.
    role.sourceCount != null && role.sourceCount > 1 ? `${role.sourceCount} sources` : null,
  ]);
  return (
    <li className={styles.role}>
      <span className={styles.roleTitleRow}>
        <span className={styles.roleTitle}>{role.title ?? "Role not on record"}</span>
        {showBadge && role.isCurrent ? <StatusBadge tone="success">Current</StatusBadge> : null}
      </span>
      {meta ? <span className={styles.roleMeta}>{meta}</span> : null}
    </li>
  );
}

function Group({ group }: { group: CompanyGroup }) {
  const name = group.companyName ?? "Unknown employer";
  // A group whose single stint carries no title and no dates is the BARE EDGE the live import path mints.
  // It renders as one company line — a company heading above an empty role row would read as broken data
  // rather than as sparse data.
  const multi = group.roles.length > 1;
  return (
    <li className={styles.group}>
      <span className={styles.monogram} aria-hidden>
        {monogram(group.companyName)}
      </span>
      <div className={styles.groupBody}>
        <span className={styles.companyRow}>
          <span className={styles.companyName}>{name}</span>
          {/* On a single-role block the badge belongs to the company line; with several roles it belongs to
              the role that is actually current, so it is rendered down there instead. */}
          {group.isCurrent && !multi ? <StatusBadge tone="success">Current</StatusBadge> : null}
          {group.totalDuration ? (
            <span className={styles.companyMeta}>
              {group.totalDuration}
              {multi ? ` · ${group.roles.length} roles` : ""}
            </span>
          ) : multi ? (
            <span className={styles.companyMeta}>{group.roles.length} roles</span>
          ) : null}
        </span>

        {group.isBareEdge ? null : (
          <ul className={styles.roles} data-multi={multi}>
            {group.roles.map((role) => (
              <Role key={role.id} role={role} showBadge={multi} />
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

export function EmploymentHistory({ groups }: { groups: CompanyGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <ul className={styles.list}>
      {groups.map((group) => (
        <Group key={group.id} group={group} />
      ))}
    </ul>
  );
}
