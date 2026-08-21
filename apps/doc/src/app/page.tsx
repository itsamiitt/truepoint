// page.tsx — the landing page. Thin route: metadata plus the mount. All behaviour lives in features/marketing.

import { HomePage } from "@/features/marketing/index.ts";

export default function HomeRoute() {
  return <HomePage />;
}
