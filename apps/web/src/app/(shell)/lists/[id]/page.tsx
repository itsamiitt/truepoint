// lists/[id]/page.tsx — the thin App Router route for one list's detail (its members). In Next.js 15 `params`
// is a Promise (awaited here); the slice component (features/lists) does the data fetch + render.
import { ListDetailPage } from "@/features/lists";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ListDetailPage listId={id} />;
}
