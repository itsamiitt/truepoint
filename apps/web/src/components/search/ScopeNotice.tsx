// ScopeNotice.tsx — says out loud that the platform-database half of the results is not being searched,
// and which active filters are the reason.
//
// The Search grid merges two engines: the workspace overlay and the global Layer-0 database. Most filter
// controls exist only on the overlay, and applying one makes the client skip the global query entirely —
// which is the correct semantics (answering "owner = me" against records nobody owns would be a lie), but
// it used to happen in total silence. The user picked a headcount range and half their results disappeared
// with nothing on screen connecting the two. Thirteen of the twenty People controls did this.
//
// So: skipping stays, the silence goes.
"use client";

import { Info } from "lucide-react";
import styles from "./search.module.css";

export function ScopeNotice({
  fields,
  labelFor,
  skipped = "database",
}: {
  /** The active filter fields that caused the skip. Empty renders nothing. */
  fields: string[];
  /** Field → the sidebar label the user actually saw, so the notice names the control they touched. */
  labelFor: (field: string) => string;
  /**
   * WHICH half was skipped. The two directions are symmetric and both real:
   *   "database"  — workspace-only filters (owner, outreach state, ranges) skipped the platform database.
   *   "workspace" — Layer-0 satellite filters (skill, school, field of study, language) skipped the
   *                 workspace overlay, which physically cannot answer them.
   */
  skipped?: "database" | "workspace";
}) {
  if (fields.length === 0) return null;
  const names = fields.map(labelFor);
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const one = names.length === 1;

  return (
    <p className={styles.scopeNotice}>
      <Info size={14} aria-hidden className={styles.scopeNoticeIcon} />
      {skipped === "database" ? (
        <span>
          Showing your workspace only — {list} {one ? "applies" : "apply"} to records you already
          hold, so the platform database is not being searched. Clear {one ? "it" : "them"} to
          search the database too.
        </span>
      ) : (
        <span>
          Searching the platform database — {list} {one ? "is" : "are"} only recorded there, not on
          your own contacts. Anyone already in your workspace still appears, marked. Clear{" "}
          {one ? "it" : "them"} to search your workspace too.
        </span>
      )}
    </p>
  );
}
