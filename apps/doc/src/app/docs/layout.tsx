// docs/layout.tsx — the sidebar frame every documentation page inherits.
//
// Declared once here rather than per page: adding a guide or an endpoint is adding content, and the route
// picks up the navigation without anyone remembering to wrap it.

import { DocsShell } from "@/features/api-reference/index.ts";
import type { ReactNode } from "react";

export default function DocsLayout({ children }: { children: ReactNode }) {
  return <DocsShell>{children}</DocsShell>;
}
