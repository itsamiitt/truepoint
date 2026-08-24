// authentication.ts — how API keys work. Written to be read by someone who has just leaked one.

import type { Guide } from "../types.ts";

export const AUTHENTICATION: Guide = {
  slug: "authentication",
  title: "Authentication",
  summary: "Bearer API keys: how to send them, how to scope them, and what to do when one leaks.",
  blocks: [
    {
      kind: "p",
      text: "Every request carries an API key as a bearer token. There is no other authentication scheme — no query-parameter key, no basic auth, no session.",
    },
    {
      kind: "code",
      language: "bash",
      source: `curl "https://api.truepoint.in/api/v1/public/company/match?domain=northgate.example.com" \\
  -H "Authorization: Bearer $TRUEPOINT_API_KEY"`,
    },
    {
      kind: "note",
      tone: "warning",
      text: "A key is a server-side credential. It must never reach a browser bundle, a mobile app, or a client-side agent you do not control — anything shipped to a user's device is readable by that user. Calls to this API belong on your backend.",
    },
    { kind: "h2", text: "Keys are shown once" },
    {
      kind: "p",
      text: "A new key is displayed at creation and never again; we store a hash, not the value. If you lose it, you rotate it. This is deliberate — a vendor who can show you your own key can also show it to whoever compromises them.",
    },
    { kind: "h2", text: "Rotation, and what to do after a leak" },
    {
      kind: "list",
      items: [
        "Create the replacement key first, so you are never running with none.",
        "Deploy it everywhere the old key was used.",
        "Revoke the old key. Revocation takes effect immediately; in-flight requests using it fail with 401.",
        "If the leak was public — a committed .env, a pasted log — revoke first and reconcile afterwards. A key in a public repository is being used within minutes.",
      ],
    },
    { kind: "h2", text: "One key per environment, at minimum" },
    {
      kind: "p",
      text: "Separate keys for production and staging cost nothing and make usage attributable. When a spike appears on your invoice, the question you want to answer is which system caused it, and a single shared key cannot answer that.",
    },
    { kind: "h2", text: "What a key does not do" },
    {
      kind: "p",
      text: "A data API key authenticates you to this API only. It is not a TruePoint application login, it carries no workspace membership, and it cannot read anything in the TruePoint CRM. Those are separate systems with separate credentials, and neither can be used to reach the other.",
    },
  ],
};
