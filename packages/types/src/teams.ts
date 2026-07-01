// teams.ts — the API contract for TEAMS (Part D, decision #6): the workspace grouping/label + its roster.
// GROUPING ONLY — these shapes describe an org-chart, never a permission. The `/api/v1/teams` surface is
// workspace-scoped; writes are workspace-admin gated.

import { z } from "zod";

/** One team as the teams list renders it (with a member count). */
export const teamViewSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  memberCount: z.number().int().nonnegative(),
  createdAt: z.string(), // ISO-8601
});
export type TeamView = z.infer<typeof teamViewSchema>;

/** One member in a team's roster. */
export const teamMemberViewSchema = z.object({
  userId: z.string().uuid(),
  email: z.string(),
  fullName: z.string().nullable(),
});
export type TeamMemberView = z.infer<typeof teamMemberViewSchema>;

/** POST /teams body. */
export const createTeamSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
});
export type CreateTeamInput = z.infer<typeof createTeamSchema>;

/** PATCH /teams/:id body — at least one field. */
export const updateTeamSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined, "Provide a field to update");
export type UpdateTeamInput = z.infer<typeof updateTeamSchema>;

/** POST /teams/:id/members body — add a workspace member by EMAIL (the roster is per-user; the server resolves
 *  the email to a tenant member). */
export const addTeamMemberSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
});
export type AddTeamMemberInput = z.infer<typeof addTeamMemberSchema>;
