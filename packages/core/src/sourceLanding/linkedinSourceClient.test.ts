// The vendor's wire format is an ENVELOPE ({success, data, meta}); every contract downstream — the zod
// payload schemas, the mapper, the content hash — is defined over the DOCUMENT. Getting this wrong is
// invisible at runtime (the fetch 200s, the parse fails, and the registry used to record success), so the
// peel is pinned here. Tested as a PURE function: no module mocks, because `mock.module` is process-global
// in bun and leaks into every other test file in the run.
import { describe, expect, test } from "bun:test";
import { unwrapEnvelope } from "./linkedinSourceClient.ts";

const PERSON = { schema_version: 1, profile_id: "ACwAA1", public_identifier: "fkamal2" };

describe("vendor envelope", () => {
  test("unwraps {success, data} to the document", () => {
    const out = unwrapEnvelope({
      success: true,
      data: PERSON,
      meta: { captured_at: "2026-08-12T09:14:02.117Z", engine: "browser" },
    });
    expect(out).toEqual({ kind: "ok", payload: PERSON });
  });

  test("a bare document (no envelope) still works", () => {
    expect(unwrapEnvelope(PERSON)).toEqual({ kind: "ok", payload: PERSON });
  });

  test("success:false is a REJECTED request — no other origin would answer differently", () => {
    expect(unwrapEnvelope({ success: false, error: "not found" })).toEqual({
      kind: "rejected",
      httpStatus: 200,
    });
  });

  test("success:true with no data object fails the attempt rather than landing junk", () => {
    const out = unwrapEnvelope({ success: true, data: null });
    expect(out.kind).toBe("failed");
  });

  test("a company envelope peels the same way", () => {
    const company = { schema_version: 2, company_id: 296229, name: "Otsuka" };
    expect(unwrapEnvelope({ success: true, data: company, meta: {} })).toEqual({
      kind: "ok",
      payload: company,
    });
  });
});
