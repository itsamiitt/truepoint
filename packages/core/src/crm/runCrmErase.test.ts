// runCrmErase.test.ts — the outbound DSAR erase (crm-sync 00 §7.6). Injected deps; no DB, no network.
//
// ONE PROPERTY DOMINATES THIS FILE: the link row must survive every failure. It carries the crm_record_id —
// the only pointer to what the CRM must delete — and it is what the DSAR residual scan counts. Deleting it
// on a failure would strand the subject in the customer's CRM, erase the evidence they are still there, and
// let the request report `completed`. That is a false erasure claim on a regulated request, so almost every
// test here asserts `deleteLink` was NOT called.

import { describe, expect, mock, test } from "bun:test";
import type { CrmConnector } from "./port.ts";
import { type CrmEraseDeps, eraseModeFor, runCrmErase } from "./runCrmErase.ts";

function fakeConnector(outcome: unknown = { kind: "ok", value: undefined, limits: {} }) {
  const eraseOrSuppress = mock(async () => outcome);
  return {
    provider: "salesforce",
    configured: true,
    eraseOrSuppress,
  } as unknown as CrmConnector & { eraseOrSuppress: ReturnType<typeof mock> };
}

function fakeDeps(over: Partial<CrmEraseDeps> = {}) {
  const deleteLink = mock(async () => {});
  const writeEraseAudit = mock(async (_a: { crmRecordId: string; mode: string }) => {});
  const deps: CrmEraseDeps = {
    loadTokenBundle: async () => ({
      accessToken: "tok",
      expiresAt: 0,
      scopes: [],
      environment: "production" as const,
    }),
    deleteLink,
    writeEraseAudit,
    ...over,
  };
  return Object.assign(deps, { deleteLink, writeEraseAudit });
}

const run = (
  connector: CrmConnector,
  deps: CrmEraseDeps,
  over: Partial<Parameters<typeof runCrmErase>[0]> = {},
) =>
  runCrmErase({
    provider: "salesforce",
    objectType: "contact",
    linkId: "link-1",
    crmRecordId: "SFDC-1",
    mode: "anonymize",
    envEnabled: true,
    connector,
    deps,
    ...over,
  });

describe("the link survives every failure", () => {
  test("a provider error leaves the link in place, so the DSAR stays blocked", async () => {
    const deps = fakeDeps();
    const r = await run(fakeConnector({ kind: "transient", status: 503 }), deps);

    expect(r.outcome).toBe("failed");
    expect(r.linkCleared).toBe(false);
    // THE assertion of this file. A DSAR blocked by a real failure is correct; a DSAR that completes
    // because an erase quietly failed is a false claim on a regulated request.
    expect(deps.deleteLink).not.toHaveBeenCalled();
    expect(deps.writeEraseAudit).not.toHaveBeenCalled();
  });

  test("an auth failure does not clear the link", async () => {
    const deps = fakeDeps();
    const r = await run(fakeConnector({ kind: "auth_revoked" }), deps);
    expect(r.outcome).toBe("failed");
    expect(deps.deleteLink).not.toHaveBeenCalled();
  });

  test("a validation failure does not clear the link", async () => {
    const deps = fakeDeps();
    await run(fakeConnector({ kind: "validation", detail: {} }), deps);
    expect(deps.deleteLink).not.toHaveBeenCalled();
  });

  test("rate limiting does not clear the link and reports the provider's delay", async () => {
    const deps = fakeDeps();
    const r = await run(
      fakeConnector({ kind: "rate_limited", retryAfterMs: 30_000, daily: false }),
      deps,
    );
    expect(r.outcome).toBe("rate_limited");
    expect(r.retryAfterMs).toBe(30_000);
    expect(deps.deleteLink).not.toHaveBeenCalled();
  });

  test("the engine being OFF leaves the link, so the DSAR cannot complete", async () => {
    const connector = fakeConnector();
    const deps = fakeDeps();
    const r = await run(connector, deps, { envEnabled: false });

    expect(r.outcome).toBe("gated");
    expect(r.linkCleared).toBe(false);
    expect(deps.deleteLink).not.toHaveBeenCalled();
    // No credential was even loaded, and nothing was sent.
    expect(connector.eraseOrSuppress).not.toHaveBeenCalled();
  });
});

describe("confirmation clears the link — and only confirmation", () => {
  test("a confirmed erase deletes the link and audits", async () => {
    const deps = fakeDeps();
    const r = await run(fakeConnector(), deps);

    expect(r.outcome).toBe("erased");
    expect(r.linkCleared).toBe(true);
    expect(deps.deleteLink).toHaveBeenCalledWith("link-1");
    expect(deps.writeEraseAudit).toHaveBeenCalledTimes(1);
  });

  test("a record already absent from the CRM is success, not a permanent block", async () => {
    // Leaving the link would block the DSAR forever on a record that no longer exists.
    const deps = fakeDeps();
    const r = await run(fakeConnector({ kind: "not_found" }), deps);
    expect(r.outcome).toBe("already_absent");
    expect(r.linkCleared).toBe(true);
    expect(deps.deleteLink).toHaveBeenCalledTimes(1);
  });

  test("the audit carries the record id and mode — never the subject's data", async () => {
    const deps = fakeDeps();
    await run(fakeConnector(), deps);
    const arg = deps.writeEraseAudit.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(Object.keys(arg ?? {}).sort()).toEqual(["crmRecordId", "mode"]);
  });
});

describe("sync_mode is deliberately NOT consulted", () => {
  test("a connection still in shadow is erased anyway", async () => {
    // Shadow is a dark-launch gate for ordinary sync traffic. An erasure is a legal obligation: the subject's
    // data is in the CRM whether or not the operator has finished piloting the integration, and refusing to
    // erase it on those grounds would be indefensible. The runner takes no syncMode input at all — this test
    // pins that by driving a full erase with only the env gate open.
    const deps = fakeDeps();
    const r = await run(fakeConnector(), deps, { envEnabled: true });
    expect(r.outcome).toBe("erased");
  });
});

describe("eraseModeFor", () => {
  test("HubSpot uses its real GDPR delete", () => {
    expect(eraseModeFor("hubspot", "contact")).toBe("gdpr_delete");
  });

  test("a Salesforce Contact is ANONYMISED, not hard-deleted", () => {
    // A Contact carries the customer's own activity history; a hard delete would break their records.
    // Anonymise-and-suppress destroys the personal data while leaving referential integrity intact.
    expect(eraseModeFor("salesforce", "contact")).toBe("anonymize");
    expect(eraseModeFor("salesforce", "account")).toBe("anonymize");
  });

  test("a Salesforce Lead CAN be hard-deleted — it carries no downstream history", () => {
    expect(eraseModeFor("salesforce", "lead")).toBe("delete");
  });
});
