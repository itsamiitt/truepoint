// Internal barrel for the reports SVG charts (private to the slice; the slice's public surface stays ReportsPage
// via ../index.ts). Lightweight, token-driven, dependency-free chart primitives used by the section components.
export { BarChart, type BarDatum } from "./BarChart";
export { LineChart, type LinePoint } from "./LineChart";
export { FunnelChart, type FunnelDatum } from "./FunnelChart";
export { DistributionChart, type DistributionSegment } from "./DistributionChart";
