// Public surface of the platform feature-flags admin slice (13 §3.5, ADR-0011): the screen the
// /feature-flags route renders. The admin shell (a sibling unit) mounts this; nothing else is public.
export { FeatureFlagsPage } from "./components/FeatureFlagsPage";
