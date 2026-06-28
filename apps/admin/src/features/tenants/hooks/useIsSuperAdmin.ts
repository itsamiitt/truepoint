// useIsSuperAdmin.ts — resolves whether the signed-in staff caller holds the super_admin role, for
// RENDER-GATING the lockout-capable auth-enforcement switch. Delegates to lib/adminGate.verifySuperAdmin
// (a probe of a super_admin-only api read) — render-gate only; the api re-checks the role on the write, which
// is the real boundary. loading/error/reload so the card can show the four async states. Presentation state.
"use client";

import { verifySuperAdmin } from "@/lib/adminGate";
import { useCallback, useEffect, useState } from "react";

export function useIsSuperAdmin() {
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setIsSuperAdmin(await verifySuperAdmin());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not verify role");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { isSuperAdmin, error, loading, reload };
}
