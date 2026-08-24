"use client";

// global-error.tsx — the last-resort App Router boundary: root-layout failures and render errors that no
// nested error.tsx caught. Next replaces the whole document here, so this file owns <html>/<body>.
import * as Sentry from "@sentry/nextjs";
import NextError from "next/error";
import { useEffect } from "react";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <NextError statusCode={0} />
      </body>
    </html>
  );
}
