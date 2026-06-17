// tenants/[id]/page.tsx — the thin App Router route for one tenant's detail. In Next.js 15 `params` is a
// Promise (awaited here); the slice component (features/tenants) does the data fetch + render.
import { TenantDetailPage } from "@/features/tenants";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TenantDetailPage tenantId={id} />;
}
