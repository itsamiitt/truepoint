// types.ts — view shapes for the Workspace settings scope (general + members & roles, 12 §3). These follow the
// documented /workspaces contract; when a backend route isn't built yet the api layer reports it (available /
// null) and the panels degrade to empty/disabled states rather than inventing data.

export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";

export interface WorkspaceGeneral {
  name: string;
  slug: string;
  /** Data-residency region key. */
  region: string;
  /** IANA timezone, e.g. "America/New_York". */
  timezone: string;
}

export interface WorkspaceMember {
  id: string;
  email: string;
  name?: string | null;
  role: WorkspaceRole;
  status: "active" | "invited";
  /** ISO timestamp or null for a pending invite. */
  joinedAt?: string | null;
}

/** `available` is false when the members route isn't built yet. */
export interface MembersFeed {
  available: boolean;
  members: WorkspaceMember[];
}

export const ROLE_LABEL: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
};

/** Assignable roles in the invite/role controls (owner is set by transfer, not assignment). */
export const ASSIGNABLE_ROLES: WorkspaceRole[] = ["admin", "member", "viewer"];

export const REGIONS = [
  { value: "us", label: "United States (us-east-1)" },
  { value: "eu", label: "European Union (eu-west-1)" },
  { value: "ap", label: "Asia Pacific (ap-southeast-1)" },
];

export const TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Singapore",
  "Asia/Kolkata",
  "Australia/Sydney",
  "UTC",
];

// ── Security ▸ Sessions (G-AUTH-2): a workspace admin lists members' active sessions and revokes them ──────
export interface WorkspaceSession {
  /** Opaque session id (used as the row key + for the revoke call). */
  id: string;
  userId: string;
  userEmail: string;
  userName?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  /** ISO timestamp. */
  createdAt: string;
  /** ISO timestamp or null if never refreshed. */
  lastSeenAt?: string | null;
  /** ISO timestamp. */
  expiresAt: string;
  /** True if this is the viewing admin's own current session. */
  current: boolean;
}

/** `available` is false when the sessions route isn't built yet (404/501). */
export interface SessionsFeed {
  available: boolean;
  sessions: WorkspaceSession[];
}
