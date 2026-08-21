// (shell)/prospect/page.tsx — retired route (search-consolidation): the prospecting surface is now /search,
// with People and Accounts as tabs. This redirect is kept for one release so bookmarks, saved-search links,
// notification deep links and stale entry points land on the new home; then the file is deleted.
//
// The query string is preserved on purpose: /search reads the SAME `q`/`sort`/`f` keys the Prospect page
// wrote, so a shared filtered view keeps working. A legacy `?scope=accounts` is translated to the Accounts
// tab by useSearchTab rather than being rewritten here.
import { redirect } from "next/navigation";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<never> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === "string") params.set(key, value);
    else if (Array.isArray(value) && value[0] !== undefined) params.set(key, value[0]);
  }
  const qs = params.toString();
  redirect(qs ? `/search?${qs}` : "/search");
}
