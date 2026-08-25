// components/data-health — the shared Data Health cell (score + freshness band), rendered by both the
// list-detail members table and the Search people grid. It lives here rather than in either feature because
// a feature slice may not import another one (lint:cross-feature). Imports nothing from features/.
export { DataHealthCell } from "./DataHealthCell";
