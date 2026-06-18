// Public surface of the workspaces feature slice: the authenticated workspace-list router, and the
// workspace-admin session-management router (G-AUTH-2: list/revoke/force-reauth member sessions).
export { workspacesRoutes } from "./routes.ts";
export { workspaceSecurityRoutes } from "./sessionRoutes.ts";
