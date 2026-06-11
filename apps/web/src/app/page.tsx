// page.tsx — the app root. The work surface is the (shell) route group; "/" just redirects to the default
// destination (Prospect, 04 §3). Auth/session resolution now lives in the AppShell (which wraps every
// (shell) route), not here. A client redirect keeps this a pure SPA hop with no flash of root content.
"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/prospect");
  }, [router]);

  return (
    <div className="tp-center-screen">
      <p className="app-muted">Loading…</p>
    </div>
  );
}
