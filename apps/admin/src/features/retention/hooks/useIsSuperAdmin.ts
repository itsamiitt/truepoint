// useIsSuperAdmin.ts — resolves whether the signed-in staff caller holds super_admin, for RENDER-GATING the
// policy editor (only super_admin may flip a class to `enforce`, which arms permanent deletion). Wraps the
// SHARED lib primitive `verifySuperAdmin` (lib/adminGate, a probe of a super_admin-only api read) so the gate
// logic isn't re-implemented; this is RENDER-GATE only — the api re-checks requireStaffRole("super_admin")
// on the write, which is the real boundary. (A twin wrapper exists in features/tenants; both lean on the
// same lib probe rather than copying its logic.) loading/error/reload for the four async states.
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
