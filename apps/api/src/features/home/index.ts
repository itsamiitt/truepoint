// Public surface of the home feature slice: the authenticated Home dashboard router.
export { homeRoutes } from "./routes.ts";
// Cross-feature seam (16 §3.3): the reverification queue-health probe the admin system-health surface uses.
export { reverificationQueueHealth } from "./reverificationQueue.ts";
