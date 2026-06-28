// Public surface of the retention admin slice (data-management A2 + A5): the Tabs host the /retention route
// renders — Policies (the global per-class TTL/mode editor) + Runs (the cross-tenant SHADOW run review). The
// admin shell mounts RetentionPage; the per-tab components are internal to the slice.
export { RetentionPage } from "./components/RetentionPage";
