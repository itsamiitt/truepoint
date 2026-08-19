// zoominfoAuth.ts — ZoomInfo's credential is a MINTED, short-lived token, never a static key. The adapter
// therefore holds a token cache and re-mints before expiry, or a long-running worker starts 401-ing.
//
// THREE flows, in preference order:
//   • CLIENT CREDENTIALS (GTM API — what we run) — POST https://api.zoominfo.com/gtm/oauth/v1/token,
//     `grant_type=client_credentials` form-encoded, credentials in an HTTP Basic header (ZoomInfo's
//     recommended placement — a body-borne secret gets logged by more middleware than a header does).
//     Response: { access_token, expires_in, scope, token_type: "Bearer" }.
//   • PKI (legacy Enterprise API) — RS256 assertion signed with the account's private key, POSTed to
//     /authenticate with the username and client id.
//   • BASIC (legacy Enterprise API) — POST { username, password } to /authenticate. Response: { jwt }.
//
// Everything fails QUIET: unconfigured, or a mint that errors, yields null, which the provider turns into a
// permanent `miss`. An enrichment vendor is never allowed to throw into the waterfall.
import { createSign } from "node:crypto";
import { env } from "@leadwolf/config";

/** GTM client-credentials token endpoint (docs.zoominfo.com/docs/client-credentials-flow). */
const OAUTH_TOKEN_URL = "https://api.zoominfo.com/gtm/oauth/v1/token";
/** Legacy Enterprise mint — username/password or a PKI assertion. */
const LEGACY_AUTH_URL = "https://api.zoominfo.com/authenticate";
/** Re-mint this long before the stated expiry, so an in-flight call never races the boundary. */
const RENEW_SKEW_MS = 5 * 60_000;
/** ZoomInfo's tokens run ~60 minutes; used only when the response states no lifetime. */
const ASSUMED_TTL_MS = 55 * 60_000;

export type AuthFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<{ status: number; json: unknown }>;

export interface CachedToken {
  token: string;
  expiresAtMs: number;
}
let cached: CachedToken | null = null;
let inFlight: Promise<string | null> | null = null;
/** When the last mint FAILED (0 = never). Failures are negatively cached briefly (perf-audit P4.4): without
 *  this, every subsequent enrich re-paid a fresh auth round trip — up to the provider timeout, inside the
 *  waterfall — against the token endpoint ZoomInfo rate-limits separately from the data endpoints. */
let mintFailedAtMs = 0;
const MINT_FAILURE_COOLDOWN_MS = 30_000;

/** Test seam + operator escape hatch: drop the cached token (a rotated credential must not wait an hour). */
export function resetZoominfoToken(): void {
  cached = null;
  inFlight = null;
  mintFailedAtMs = 0;
}

function privateKeyPem(): string | undefined {
  if (env.ZOOMINFO_PRIVATE_KEY) return env.ZOOMINFO_PRIVATE_KEY;
  if (env.ZOOMINFO_PRIVATE_KEY_B64) {
    try {
      return Buffer.from(env.ZOOMINFO_PRIVATE_KEY_B64, "base64").toString("utf8");
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * The RS256 client assertion for the legacy PKI flow. Claims follow ZoomInfo's published client libraries:
 * the client id identifies the application (`iss`), the username the acting principal (`sub`), and the
 * assertion is short-lived. A wrong claim set surfaces as a 401 from /authenticate (a zero-cost `miss`),
 * never as bad data.
 */
export function buildClientAssertion(
  username: string,
  clientId: string,
  privateKey: string,
  nowMs: number = Date.now(),
): string {
  const header = { alg: "RS256", typ: "JWT" };
  const iat = Math.floor(nowMs / 1000);
  const payload = { iss: clientId, sub: username, aud: LEGACY_AUTH_URL, iat, exp: iat + 300 };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(privateKey, "base64url")}`;
}

/** `exp` out of a JWT body, in ms — best effort; an unreadable token falls back to the assumed TTL. */
function jwtExpiry(token: string, nowMs: number): number {
  const body = token.split(".")[1];
  if (!body) return nowMs + ASSUMED_TTL_MS;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { exp?: number };
    return typeof parsed.exp === "number" ? parsed.exp * 1000 : nowMs + ASSUMED_TTL_MS;
  } catch {
    return nowMs + ASSUMED_TTL_MS;
  }
}

const defaultAuthFetch: AuthFetch = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    redirect: "error",
    signal: AbortSignal.timeout(env.ENRICH_PROVIDER_TIMEOUT_MS),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
};

/** The credential set actually configured — null when ZoomInfo cannot authenticate at all. */
function credentials():
  | { kind: "preminted"; token: string }
  | { kind: "client_credentials"; clientId: string; clientSecret: string }
  | { kind: "pki"; username: string; clientId: string; privateKey: string }
  | { kind: "basic"; username: string; password: string }
  | null {
  if (env.ZOOMINFO_CLIENT_ID && env.ZOOMINFO_CLIENT_SECRET) {
    return {
      kind: "client_credentials",
      clientId: env.ZOOMINFO_CLIENT_ID,
      clientSecret: env.ZOOMINFO_CLIENT_SECRET,
    };
  }
  const username = env.ZOOMINFO_USERNAME;
  const key = privateKeyPem();
  if (username && env.ZOOMINFO_CLIENT_ID && key) {
    return { kind: "pki", username, clientId: env.ZOOMINFO_CLIENT_ID, privateKey: key };
  }
  if (username && env.ZOOMINFO_PASSWORD) {
    return { kind: "basic", username, password: env.ZOOMINFO_PASSWORD };
  }
  // Last: a pre-minted token pasted by an operator. Ranked BELOW the real flows because it expires within
  // the hour and cannot renew itself.
  if (env.ZOOMINFO_API_KEY) return { kind: "preminted", token: env.ZOOMINFO_API_KEY };
  return null;
}

/** Which flow is configured — surfaced by the ops probe so a half-configured vendor is diagnosable. */
export function zoominfoCredentialState():
  | "client_credentials"
  | "pki"
  | "basic"
  | "preminted"
  | "unconfigured" {
  return credentials()?.kind ?? "unconfigured";
}

/** Pull the token + its lifetime out of either mint's response shape. Exported for its own test: the
 *  credential state is unconfigured in CI, so this is the only way to prove the parse without mocking. */
export function parseTokenResponse(json: unknown, nowMs: number): CachedToken | null {
  if (typeof json !== "object" || json === null) return null;
  const body = json as Record<string, unknown>;
  const oauth = body.access_token;
  if (typeof oauth === "string" && oauth.length > 0) {
    const ttl = typeof body.expires_in === "number" ? body.expires_in * 1000 : ASSUMED_TTL_MS;
    return { token: oauth, expiresAtMs: nowMs + ttl };
  }
  const legacy = body.jwt;
  if (typeof legacy === "string" && legacy.length > 0) {
    return { token: legacy, expiresAtMs: jwtExpiry(legacy, nowMs) };
  }
  return null;
}

async function mint(authFetch: AuthFetch): Promise<CachedToken | null> {
  const creds = credentials();
  if (!creds) return null;
  if (creds.kind === "preminted") {
    return { token: creds.token, expiresAtMs: jwtExpiry(creds.token, Date.now()) };
  }

  const request: { url: string; headers: Record<string, string>; body: string } =
    creds.kind === "client_credentials"
      ? {
          url: OAUTH_TOKEN_URL,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
            authorization: `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64")}`,
          },
          body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
        }
      : {
          url: LEGACY_AUTH_URL,
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(
            creds.kind === "pki"
              ? {
                  username: creds.username,
                  clientId: creds.clientId,
                  jwt: buildClientAssertion(creds.username, creds.clientId, creds.privateKey),
                }
              : { username: creds.username, password: creds.password },
          ),
        };

  try {
    const res = await authFetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
    });
    if (res.status >= 400) {
      // Status + flow only. The response body of a failed auth can echo the credential.
      console.error("[zoominfo] token mint failed", { status: res.status, flow: creds.kind });
      return null;
    }
    const token = parseTokenResponse(res.json, Date.now());
    if (!token) console.error("[zoominfo] token mint returned no token", { flow: creds.kind });
    return token;
  } catch (e) {
    console.error("[zoominfo] token mint threw", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/**
 * A live ZoomInfo access token, minted on demand and cached until shortly before it expires. Concurrent
 * callers share ONE mint (the in-flight promise): a burst of enrichment jobs must not each spend an auth
 * call, and ZoomInfo rate-limits the token endpoint separately from the data endpoints.
 */
export async function zoominfoToken(
  authFetch: AuthFetch = defaultAuthFetch,
): Promise<string | null> {
  const now = Date.now();
  if (cached && cached.expiresAtMs - RENEW_SKEW_MS > now) return cached.token;
  // Negative cache: a mint that just failed will not succeed milliseconds later — answer `miss` fast for
  // the cooldown window instead of paying an auth round trip per enrich against a rate-limited endpoint.
  if (mintFailedAtMs !== 0 && now - mintFailedAtMs < MINT_FAILURE_COOLDOWN_MS) return null;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const minted = await mint(authFetch);
    cached = minted;
    mintFailedAtMs = minted ? 0 : Date.now();
    return minted?.token ?? null;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
