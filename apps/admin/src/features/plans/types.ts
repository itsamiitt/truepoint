// types.ts — the shape the Plans area renders. Mirrors the api `/admin/pricing/plan-templates` payload
// (apps/api/src/features/admin/pricing.ts, backed by @leadwolf/db planTemplateRepository). Presentation-side
// type only; the api owns the canonical shape.

export interface PlanTemplate {
  key: string;
  name: string;
  seatLimit: number;
  workspaceLimit: number | null;
  monthlyCreditGrant: number | null;
  features: Record<string, boolean>;
  active: boolean;
  sortOrder: number;
  updatedAt: string;
}
