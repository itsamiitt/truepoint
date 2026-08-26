// PostingsSection.tsx — open roles for this company (MI-S1/MI-4). Self-hides while the postings feed is
// dark (resolved:false or zero rows) — the section appears the day the D-6 feed lands, no UI change.
//
// A FAILED read is not the same thing as a dark feed and must not render like one. Reading only
// `query.data` made an HTTP 500 indistinguishable from "the flag is off": the section vanished, and the
// user was told nothing was wrong. The error branch below comes FIRST; the self-hide keeps its meaning
// only for the no-error cases.
"use client";

import { fetchWithAuth } from "@/lib/authClient";
import { problemMessage } from "@/lib/problemMessage";
import { API_BASE } from "@/lib/publicConfig";
import type { AccountPostingsResponse } from "@leadwolf/types";
import { ErrorState } from "@leadwolf/ui";
import { useQuery } from "@tanstack/react-query";
import styles from "../accounts.module.css";

async function fetchPostings(accountId: string): Promise<AccountPostingsResponse> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/accounts/${encodeURIComponent(accountId)}/postings`,
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load postings"));
  return (await res.json()) as AccountPostingsResponse;
}

export function PostingsSection({ accountId }: { accountId: string }) {
  const query = useQuery({
    queryKey: ["companies", "postings", accountId],
    queryFn: () => fetchPostings(accountId),
  });
  if (query.error) {
    return (
      <div>
        <h2 className={styles.sectionTitle}>Open roles</h2>
        <ErrorState
          title="Couldn't load open roles"
          detail={query.error instanceof Error ? query.error.message : undefined}
          onRetry={() => void query.refetch()}
        />
      </div>
    );
  }

  const data = query.data;
  if (!data || !data.resolved || data.postings.length === 0) return null;

  return (
    <div>
      <h2 className={styles.sectionTitle}>Open roles</h2>
      {data.by_department.length > 1 ? (
        <p className={styles.deptSummary}>
          {data.by_department
            .slice(0, 4)
            .map((d) => `${d.department ?? "Other"} · ${d.count}`)
            .join("  ·  ")}
        </p>
      ) : null}
      <ul className={styles.signalList}>
        {data.postings.slice(0, 10).map((p) => (
          <li key={`${p.title}-${p.location ?? ""}`} className={styles.signalItem}>
            <span className={styles.signalHeadline}>{p.title}</span>
            <span className={styles.signalTime}>
              {[p.department, p.location].filter(Boolean).join(" · ")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
