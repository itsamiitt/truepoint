// (shell)/companies/[accountId]/page.tsx — the routed company page (market-intelligence MI-1). Thin:
// all behavior lives in the feature slice (features/companies). Signal rows and the account drawer
// deep-link here; the drawer remains the in-search preview.
import { CompanyPage } from "@/features/companies";

export default async function CompanyRoute({
  params,
}: {
  params: Promise<{ accountId: string }>;
}) {
  const { accountId } = await params;
  return <CompanyPage accountId={accountId} />;
}
