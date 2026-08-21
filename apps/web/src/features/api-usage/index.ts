// api-usage — the tenant's public-API consumption (ADR-0049): the data hook, and the sparkline that draws it.
//
// The CARD that renders these lives in features/home, not here, and the split is the boundary rule doing its
// job: the cockpit's WidgetCard frame is internal to features/home, so a card built here would have to reach
// across into another slice's internals. Data flows the legal direction instead — home imports this public
// surface, and this slice knows nothing about the cockpit.
export { useApiUsage } from "./hooks/useApiUsage";
export { UsageSparkline, type UsagePoint } from "./components/UsageSparkline";
export type { ApiUsageFeed } from "./api";
