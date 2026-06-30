// useSessionRole.ts — re-exported from the shared @/lib hook (promoted so the billing hub can reuse the same
// active-workspace-role probe for its OD-8 purchase gate). The implementation originally lived here; kept as a
// re-export so existing imports (DataHealthPage) keep working unchanged.
export { useSessionRole } from "@/lib/useSessionRole";
