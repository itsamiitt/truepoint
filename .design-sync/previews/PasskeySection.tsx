// PasskeySection — registered passkeys, the WebAuthn add ceremony, and removal. Add and remove are
// state-changing credential actions, so both require a step-up: the user re-proves their current password
// or authenticator code, and a wrong one comes back 403 as "didn't match".
//
// The component lists passkeys with a bare `fetch` to its own route, whose failure it deliberately swallows
// ("a failed list load just shows an empty list; the add flow still works"). In a preview that fetch has
// nowhere to go, so the list would always be empty — the least informative of its states. The shim below
// answers ONLY that one route from fixtures and delegates everything else untouched, which is the same
// fixture-router treatment the other apps' cards get, scoped to a single URL.
//
// The ceremony itself is never triggered: navigator.credentials.create is a real platform prompt and a card
// must not raise one. What the cells show is the surface either side of that prompt.
import { AccountShell, PasskeySection } from "@leadwolf/ui";
import { ground } from "./_authFixtures";

const PASSKEYS = [
  { id: "pk_01hq9r1", label: "MacBook Touch ID", backedUp: true, createdAt: "2026-05-02T16:19:00Z", lastUsedAt: "2026-08-18T07:02:00Z" },
  { id: "pk_01hq9r2", label: "iPhone", backedUp: true, createdAt: "2026-06-11T09:40:00Z", lastUsedAt: "2026-08-14T18:41:00Z" },
  { id: "pk_01hq9r3", label: "YubiKey 5C", backedUp: false, createdAt: "2026-02-20T12:05:00Z", lastUsedAt: null },
];

if (typeof window !== "undefined" && !("__tpPasskeyShim" in window)) {
  (window as unknown as Record<string, unknown>).__tpPasskeyShim = true;
  const real = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/\/account\/security\/passkeys$/.test(url) && (init?.method ?? "GET") === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify({ passkeys: PASSKEYS }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return real(input as RequestInfo, init);
  }) as typeof window.fetch;
}

const Frame = ({ children, height = 620 }: { children: React.ReactNode; height?: number }) => (
  <div style={{ ...ground, height }}>
    <AccountShell title="Security" sections={[]}>
      {children}
    </AccountShell>
  </div>
);

/** Three passkeys registered, including a device-bound key that is not backed up. */
export const Registered = () => (
  <Frame>
    <PasskeySection />
  </Frame>
);
