// (shell)/search/markets/page.tsx — the market-segment board (market-intelligence MI-8). Thin: all
// behavior lives in the feature slice (features/accounts). Moved here from /companies/markets by the
// search-consolidation cutover, which retired the /companies destination; the old path redirects.
import { MarketsBoard } from "@/features/accounts";

export default function MarketsRoute() {
  return <MarketsBoard />;
}
