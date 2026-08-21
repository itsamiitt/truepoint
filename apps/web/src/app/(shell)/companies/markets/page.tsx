// (shell)/companies/markets/page.tsx — retired route (search-consolidation): the market-segment board moved
// to /search/markets with the rest of the destination. Kept for one release, then deleted.
import { redirect } from "next/navigation";

export default function Page(): never {
  redirect("/search/markets");
}
