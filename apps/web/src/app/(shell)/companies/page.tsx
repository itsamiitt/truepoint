// (shell)/companies/page.tsx — retired route (search-consolidation): company search is now the Accounts tab
// on /search. Kept for one release so bookmarks and deep links land on the new home; then deleted.
//
// The account query keys (`aq`/`asort`/`af`) are preserved verbatim — the Accounts tab reads the same codec,
// so a shared company view survives the move.
import { redirect } from "next/navigation";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<never> {
  const params = new URLSearchParams({ tab: "accounts" });
  for (const [key, value] of Object.entries(await searchParams)) {
    if (key === "tab") continue;
    if (typeof value === "string") params.set(key, value);
    else if (Array.isArray(value) && value[0] !== undefined) params.set(key, value[0]);
  }
  redirect(`/search?${params.toString()}`);
}
