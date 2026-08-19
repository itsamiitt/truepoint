// useDraftRange.ts — a keystroke buffer for the range/date facet inputs (perf-audit P0.6). The committed
// ContactQuery/AccountQuery IS the cache key for several server queries at once (search, facets, count, the
// database half), and the range inputs used to write the query on EVERY keystroke — typing "5000" into
// Headcount fired ~4-5 backend searches per character, ~20 for the number. The free-text box and the typeahead
// already debounce (300ms); this gives the nine range/date inputs the same posture: the draft holds what the
// user is typing, and commits to the real query after a quiet 400ms or immediately on blur.
"use client";

import { useEffect, useRef, useState } from "react";

/** Slightly above the text box's 300ms: range edits are digit-by-digit, and a premature commit mid-number
 *  (searching headcount ≥ 5 on the way to 5000) is worse than the extra tenth of a second. */
const COMMIT_QUIET_MS = 400;

export interface RangeDraft {
  gte?: number;
  lte?: number;
}

export function useDraftRange(
  gte: number | undefined,
  lte: number | undefined,
  commit: (next: RangeDraft) => void,
): {
  draft: RangeDraft;
  /** Buffer a keystroke and (re)arm the quiet-period commit. */
  schedule: (next: RangeDraft) => void;
  /** Commit whatever is buffered NOW (blur) — a no-op when nothing is pending. */
  flush: () => void;
} {
  const [draft, setDraft] = useState<RangeDraft>({ gte, lte });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dirty = useRef(false);
  // Always commit through the LATEST closure: the commit builds the next query from the current one, and a
  // 400ms-old closure would rebuild from a stale query, silently wiping any filter changed since the keystroke.
  const commitRef = useRef(commit);
  commitRef.current = commit;

  // External changes (clear-all, back/forward, another control, our own commit echoing back through the URL)
  // flow into the draft whenever no keystroke is pending; while the user is mid-edit the draft wins.
  useEffect(() => {
    if (!dirty.current) setDraft({ gte, lte });
  }, [gte, lte]);
  // Unmount drops a pending commit — collapsing the accordion must not fire a search.
  useEffect(() => () => clearTimeout(timer.current), []);

  const commitNow = (next: RangeDraft) => {
    clearTimeout(timer.current);
    dirty.current = false;
    commitRef.current(next);
  };

  const schedule = (next: RangeDraft) => {
    setDraft(next);
    dirty.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => commitNow(next), COMMIT_QUIET_MS);
  };

  const flush = () => {
    if (dirty.current) commitNow(draft);
  };

  return { draft, schedule, flush };
}
