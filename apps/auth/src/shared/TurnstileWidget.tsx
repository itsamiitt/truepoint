// TurnstileWidget.tsx — renders the Cloudflare Turnstile widget at the identifier step (ADR-0020). The
// Turnstile script (allow-listed in the CSP) auto-renders the `.cf-turnstile` div and injects a hidden
// `cf-turnstile-response` field into the enclosing form, which the server action verifies. Renders nothing
// when no site key is configured (local dev), so login still works without a Turnstile key.
"use client";

import Script from "next/script";

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

export function TurnstileWidget() {
  if (!SITE_KEY) return null;
  return (
    <>
      <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js" strategy="afterInteractive" />
      <div className="cf-turnstile" data-sitekey={SITE_KEY} data-theme="light" style={{ marginBottom: 16 }} />
    </>
  );
}
