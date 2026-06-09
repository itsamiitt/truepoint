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
};

for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value;
}
