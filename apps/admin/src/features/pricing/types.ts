// types.ts — the shape the Pricing area renders. Mirrors the api `/admin/pricing/credit-packs` payload
// (apps/api/src/features/admin/pricing.ts, backed by @leadwolf/db creditPackRepository). Price is integer
// cents. Presentation-side type only; the api owns the canonical shape.

export interface CreditPack {
  key: string;
  name: string;
  credits: number;
  priceCents: number;
  active: boolean;
  sortOrder: number;
  updatedAt: string;
}
