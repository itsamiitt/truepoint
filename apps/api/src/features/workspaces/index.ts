// Public surface of the workspaces feature slice: the authenticated workspace-list router, the workspace-
// admin session-management router (G-AUTH-2: list/revoke/force-reauth member sessions), and the workspace
// members router (P1-03: list/invite/change-role/remove).
export { workspacesRoutes } from "./routes.ts";
export { workspaceSecurityRoutes } from "./sessionRoutes.ts";
export { workspaceMembersRoutes } from "./memberRoutes.ts";
