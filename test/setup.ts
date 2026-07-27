// setup.ts — bun test preload. Provides a valid dummy environment so @leadwolf/config validates at import
// during unit tests. Values are non-secret placeholders; integration tests that need a real DB override
// DATABASE_URL/BLIND_INDEX_KEY before dynamically importing the code under test.

const defaults: Record<string, string> = {
  NODE_ENV: "test",
  AUTH_ORIGIN: "https://auth.test",
  APP_ORIGINS: "https://app.test",
  AUTH_COOKIE_DOMAIN: "test",
  JWT_SIGNING_KID: "test-kid",
  DATABASE_URL: "postgres://leadwolf:leadwolf@localhost:5432/leadwolf",
  REDIS_URL: "redis://localhost:6379",
  BLIND_INDEX_KEY: "test-blind-index-key-0123456789",
  // Turnstile ENFORCED under test (the bot check is opt-in and disabled without a secret). It has to be set
  // here, in the preload, rather than in the test that needs it: @leadwolf/config freezes `env` from
  // process.env the first time it is imported, so a file setting this at its own module scope only wins when
  // it happens to be the first file in the run to pull in config. packages/auth/src/botCheck.test.ts did
  // exactly that and passed alone while failing in a full run — verifyTurnstile saw no secret, took the
  // disabled path, and returned true where the test expected a fail-closed false. Enforced is also the safer
  // default for anything added later: a new test covering a login path gets the bot check ON, not silently off.
  TURNSTILE_SECRET: "test-secret",
};

for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value;
}
