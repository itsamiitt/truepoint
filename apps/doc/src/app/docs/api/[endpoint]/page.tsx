// docs/api/[endpoint]/page.tsx — one endpoint's reference page, generated from its typed spec.

import { ENDPOINTS, findEndpoint } from "@/content/endpoints/index.ts";
import { EndpointPage } from "@/features/api-reference/index.ts";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

export const dynamicParams = false;

export function generateStaticParams() {
  return ENDPOINTS.map((endpoint) => ({ endpoint: endpoint.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ endpoint: string }>;
}): Promise<Metadata> {
  const { endpoint: slug } = await params;
  const endpoint = findEndpoint(slug);
  if (!endpoint) return {};
  return {
    title: `${endpoint.method} ${endpoint.path}`,
    description: endpoint.summary,
  };
}

export default async function EndpointRoute({ params }: { params: Promise<{ endpoint: string }> }) {
  const { endpoint: slug } = await params;
  const endpoint = findEndpoint(slug);
  if (!endpoint) notFound();
  return <EndpointPage endpoint={endpoint} />;
}
