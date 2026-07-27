import { describe, expect, test } from "bun:test";

/**
 * The security headers each Next app sends (E-6.2). These apps shipped NONE before — no HSTS, no nosniff, no
 * framing policy — so this pins both what is sent and, just as importantly, what is NOT.
 *
 * Asserted by executing the real `next.config.mjs` rather than restating its contents, so the test fails when
 * the config changes rather than when someone forgets to update a copy of it.
 */
type HeaderRule = { source: string; headers: Array<{ key: string; value: string }> };

async function headersFor(app: string, nodeEnv?: string): Promise<HeaderRule[]> {
  // NODE_ENV is typed read-only, so it is written through the env record rather than the typed property.
  const env = process.env as Record<string, string | undefined>;
  const previous = env.NODE_ENV;
  if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
  try {
    // Cache-busted so the production and development reads do not share one evaluation.
    const mod = await import(`../../${app}/next.config.mjs?env=${nodeEnv ?? "default"}`);
    return (await mod.default.headers()) as HeaderRule[];
  } finally {
    env.NODE_ENV = previous;
  }
}

const headerValue = (rules: HeaderRule[], key: string): string | undefined =>
  rules[0]?.headers.find((h) => h.key === key)?.value;

describe("security headers", () => {
  for (const app of ["web", "admin", "auth", "forge"]) {
    test(`${app} sends the baseline on every path`, async () => {
      const rules = await headersFor(app);
      expect(rules[0]?.source).toBe("/:path*");
      expect(headerValue(rules, "X-Content-Type-Options")).toBe("nosniff");
      expect(headerValue(rules, "Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    });
  }

  test("the login surface and the staff consoles refuse framing outright", async () => {
    // Framing a login screen is clickjacking; the internal consoles have no legitimate embedder at all.
    for (const app of ["auth", "admin", "forge"]) {
      expect(headerValue(await headersFor(app), "X-Frame-Options")).toBe("DENY");
    }
    // The customer app keeps the same third-party protection without ruling out a first-party embed.
    expect(headerValue(await headersFor("web"), "X-Frame-Options")).toBe("SAMEORIGIN");
  });

  test("HSTS is production-only — sending it from a dev server pins localhost to HTTPS", async () => {
    // This is the trap the gate exists for: once localhost is pinned, EVERY app on it fails to load until the
    // developer clears the pin by hand, and it presents as a broken machine rather than a header.
    expect(
      headerValue(await headersFor("web", "development"), "Strict-Transport-Security"),
    ).toBeUndefined();

    const prod = headerValue(await headersFor("web", "production"), "Strict-Transport-Security");
    expect(prod).toContain("max-age=");
    expect(prod).toContain("includeSubDomains");
    // `preload` is a submission to a browser-shipped list and is slow to reverse — a deliberate decision,
    // not something to inherit from a header someone copied.
    expect(prod).not.toContain("preload");
  });
});
