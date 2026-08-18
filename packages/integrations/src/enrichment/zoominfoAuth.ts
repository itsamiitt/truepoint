// zoominfoAuth.ts — ZoomInfo's authentication is a token MINT, not a static key: every enrich call carries
// a JWT obtained from https://api.zoominfo.com/authenticate, valid ~60 minutes with NO refresh token. So the
// adapter has to hold a token cache and re-mint before expiry, or a long-running worker starts 401-ing an
// hour after boot.
//
// Two flows, both supported:
//   • BASIC   — POST { username, password }.
//   • PKI     — sign an RS256 assertion with the account's private key (client id = the application, the
//               key = the proof) and POST { username, clientId, jwt }. ZoomInfo recommends this for
//               production automation precisely because no user password sits in our infrastructure.
//
// Everything fails QUIET: unconfigured, or a mint that errors, yields null, which the provider turns into a
// permanent `miss`. An enrichment vendor is never allowed to throw into the waterfall.
import { createSign } from "node:crypto";
import { env } from "@leadwolf/config";

const AUTH_URL = "https://api.zoominfo.com/authenticate";
/** Re-mint this long before the stated expiry, so an in-flight call never races the boundary. */
const RENEW_SKEW_MS = 5 * 60_000;
/** ZoomInfo states ~60 minutes; used only when the token carries no readable `exp`. */
const ASSUMED_TTL_MS = 55 * 60_000;

export type AuthFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: unknown },
) => Promise<{ status: number; json: unknown }>;

interface CachedToken {
  jwt: string;
  expiresAtMs: number;
}
let cached: CachedToken | null = null;
let inFlight: Promise<string | null> | null = null;

/** Test seam + operator escape hatch: drop the cached token (a rotated credential must not wait an hour). */
export function resetZoominfoToken(): void {
  cached = null;
  inFlight = null;
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
 * The RS256 client assertion for the PKI flow. Claims follow ZoomInfo's published client libraries:
 * the client id identifies the application (`iss`), the username the acting principal (`sub`), and the
 * assertion is short-lived. Unverifiable from here without a real key — the first live mint is the test,
 * and a wrong claim set surfaces as a 401 from /authenticate (a zero-cost `miss`), never as bad data.
 */
export function buildClientAssertion(
  username: string,
  clientId: string,
  privateKey: string,
  nowMs: number = Date.now(),
): string {
  const header = { alg: "RS256", typ: "JWT" };
  const iat = Math.floor(nowMs / 1000);
  const payload = {
    iss: clientId,
    sub: username,
    aud: AUTH_URL,
    iat,
    exp: iat + 300,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(privateKey, "base64url")}`;
}

/** `exp` out of a JWT body, in ms — best effort; an unreadable token falls back to the assumed TTL. */
function expiryOf(jwt: string, nowMs: number): number {
  const body = jwt.split(".")[1];
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
    headers: { "content-type": "application/json", ...init.headers },
    body: JSON.stringify(init.body),
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
  | { kind: "preminted"; jwt: string }
  | { kind: "basic"; username: string; password: string }
  | { kind: "pki"; username: string; clientId: string; privateKey: string }
  | null {
  if (env.ZOOMINFO_API_KEY) return { kind: "preminted", jwt: env.ZOOMINFO_API_KEY };
  const username = env.ZOOMINFO_USERNAME;
  const key = privateKeyPem();
  if (username && env.ZOOMINFO_CLIENT_ID && key) {
    return { kind: "pki", username, clientId: env.ZOOMINFO_CLIENT_ID, privateKey: key };
  }
  if (username && env.ZOOMINFO_PASSWORD) {
    return { kind: "basic", username, password: env.ZOOMINFO_PASSWORD };
  }
  return null;
}

/** Which credential half is missing — surfaced by the admin/ops probe so a half-configured vendor is
 *  diagnosable without reading logs. */
export function zoominfoCredentialState(): "preminted" | "pki" | "basic" | "unconfigured" {
  return credentials()?.kind ?? "unconfigured";
}

async function mint(authFetch: AuthFetch): Promise<string | null> {
  const creds = credentials();
  if (!creds) return null;
  if (creds.kind === "preminted") return creds.jwt;

  const body =
    creds.kind === "pki"
      ? {
          username: creds.username,
          clientId: creds.clientId,
          jwt: buildClientAssertion(creds.username, creds.clientId, creds.privateKey),
        }
      : { username: creds.username, password: creds.password };

  try {
    const res = await authFetch(AUTH_URL, { method: "POST", headers: {}, body });
    if (res.status >= 400 || typeof res.json !== "object" || res.json === null) {
      console.error("[zoominfo] authenticate failed", { status: res.status, flow: creds.kind });
      return null;
    }
    const jwt = (res.json as Record<string, unknown>).jwt;
    return typeof jwt === "string" && jwt.length > 0 ? jwt : null;
  } catch (e) {
    console.error("[zoominfo] authenticate threw", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/**
 * A live ZoomInfo JWT, minted on demand and cached until shortly before it expires. Concurrent callers
 * share ONE mint (the in-flight promise): a burst of enrichment jobs must not each spend an auth call.
 */
export async function zoominfoToken(
  authFetch: AuthFetch = defaultAuthFetch,
): Promise<string | null> {
  const now = Date.now();
  if (cached && cached.expiresAtMs - RENEW_SKEW_MS > now) return cached.jwt;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const jwt = await mint(authFetch);
    cached = jwt ? { jwt, expiresAtMs: expiryOf(jwt, Date.now()) } : null;
    return jwt;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
