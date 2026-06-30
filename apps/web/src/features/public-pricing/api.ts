// api.ts — PUBLIC (unauthenticated) data access for the transparent pricing page (ADR-0012). Plain fetch with
// NO token, NO tenant, NO balance — the page must render logged-out. Reads only the public pricing catalog the
// api exposes at /api/v1/pricing/* (ACTIVE credit packs + plan tiers; no PII, no per-tenant data). This slice's
// only seam to the backend.

import { API_BASE } from "@/lib/publicConfig";
import type { PublicCreditPack, PublicPlan } from "@leadwolf/types";

export async function fetchPublicPlans(signal?: AbortSignal): Promise<PublicPlan[]> {
  const res = await fetch(`${API_BASE}/api/v1/pricing/plans`, { signal });
  if (!res.ok) throw new Error(`Could not load plans (${res.status})`);
  const data = (await res.json()) as { plans: PublicPlan[] };
  return data.plans;
}

export async function fetchPublicPacks(signal?: AbortSignal): Promise<PublicCreditPack[]> {
  const res = await fetch(`${API_BASE}/api/v1/pricing/credit-packs`, { signal });
  if (!res.ok) throw new Error(`Could not load credit packs (${res.status})`);
  const data = (await res.json()) as { packs: PublicCreditPack[] };
  return data.packs;
}
