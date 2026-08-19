// stubs/authClient.ts — the Forge operator console's token client, replaced by a fixture-backed router.
//
// The real module is a @leadwolf/auth-client instantiation doing PKCE + in-memory tokens + silent refresh
// against the auth origin (ADR-0016). Here `fetchWithAuth` answers the six read-only /bff routes from
// ../fixtures, so every card renders the console's LOADED state — the real components, real layout, real
// empty/error branches still reachable, just no wire.
//
// Anything unmapped falls through to an envelope carrying every collection key the slice destructures, so a
// route nobody fixtured renders an empty state rather than throwing.

import * as F from "../fixtures";

const b64url = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Not a credential: an unsigned stand-in whose only consumer is a client-side claim decode.
const FAKE_JWT = `${b64url({ alg: "none", typ: "JWT" })}.${b64url({
  sub: "00000000-0000-4000-8000-0000000000f0",
  exp: 4102444800,
})}.`;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Every collection key a Forge slice reads, so an unmapped route degrades to "empty", never to a crash. */
const EMPTY_OK = {
  ok: true, status: "ok", total: 0, count: 0,
  captures: [], parsers: [], tasks: [], fetches: [], targets: [], items: [], results: [],
};

const ROUTES: Array<[RegExp, () => unknown]> = [
  // `/bff/me` is what forgeGate.verifyForgeStaff probes to classify the caller. Fixturing the ROUTE rather
  // than stubbing the gate module means ForgeShell runs its real two-stage authn/authz path (ADR-0011 /
  // ADR-0034) and lands on the authorized branch — which is the state worth designing against.
  [/\/bff\/me\b/, () => ({
    staffRole: "data_ops",
    capabilities: ["data:read", "data:write", "review:resolve", "parser:manage"],
    email: "ops@truepoint.in",
  })],
  [/\/bff\/overview\b/, () => F.OVERVIEW],
  [/\/bff\/captures\b/, () => ({ captures: F.CAPTURES })],
  [/\/bff\/parsers\b/, () => ({ parsers: F.PARSERS })],
  [/\/bff\/review-tasks\b/, () => ({ tasks: F.REVIEW_TASKS })],
  [/\/bff\/source-fetches\b/, () => ({ fetches: F.SOURCE_FETCHES })],
  [/\/bff\/sync-status\b/, () => ({ targets: F.SYNC_TARGETS })],
];

export async function fetchWithAuth(input: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  for (const [re, body] of ROUTES) if (re.test(url)) return json(body());
  return json(EMPTY_OK);
}

export function getAccessToken(): string | null {
  return FAKE_JWT;
}
export function clearAccessToken(): void {}
export async function silentRefresh(): Promise<boolean> {
  return true;
}
export async function startLogin(): Promise<void> {}
export async function completeLogin(): Promise<void> {}
export async function logout(): Promise<void> {}

export const RECOVERY_KEY = "lw_forge_recovery";
export type RecoveryAction = "restart" | "retry" | "fail";
export function recoveryActionFor(): RecoveryAction {
  return "fail";
}
