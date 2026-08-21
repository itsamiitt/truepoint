// DocsShell.tsx — sidebar plus reading column, applied by the /docs route-group layout so every page under
// it inherits the same frame rather than re-declaring one.

import { PageContainer } from "@leadwolf/ui";
import type { ReactNode } from "react";
import styles from "../api-reference.module.css";
import { DocsSidebar } from "./DocsSidebar.tsx";

export function DocsShell({ children }: { children: ReactNode }) {
  return (
    <PageContainer width="default">
      <div className={styles.shell}>
        <DocsSidebar />
        <div>{children}</div>
      </div>
    </PageContainer>
  );
}
