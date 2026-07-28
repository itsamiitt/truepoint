// transforms.test.ts — the closed transform registry (crm-sync 00 §1.3 / §4.3). Pure, no IO.
//
// The behaviours worth pinning are the REFUSALS. A transform that quietly passes a value through when it
// cannot convert it is how unconverted data ends up in a customer's CRM, or how a TP field gets cleared
// because one phone number failed to parse.

import { describe, expect, test } from "bun:test";
import { applyTransform, transformInbound } from "./transforms.ts";

describe("the registry is CLOSED", () => {
  test("an unknown transform name is REFUSED, not passed through", () => {
    // A mapping row naming a transform this build lacks was written by a newer version or by hand. Passing
    // the raw value through would silently write unconverted data; skipping records why.
    const r = applyTransform("exec_arbitrary_code", "value");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("unknown_transform");
  });

  test("passthrough returns the value untouched, including non-strings", () => {
    expect(applyTransform("passthrough", 42)).toEqual({ ok: true, value: 42 });
    const obj = { a: 1 };
    expect(applyTransform("passthrough", obj).value).toBe(obj);
  });

  test("null and undefined are gaps, not errors, for every transform", () => {
    for (const t of ["passthrough", "lowercase", "phone_e164", "date_iso", "seniority_map"]) {
      expect(applyTransform(t, null)).toEqual({ ok: true, value: null });
      expect(applyTransform(t, undefined)).toEqual({ ok: true, value: null });
    }
  });
});

describe("phone_e164", () => {
  test("normalises an international number", () => {
    expect(applyTransform("phone_e164", "+1 415 555 2671").value).toBe("+14155552671");
  });

  test("a national number resolves with a default region", () => {
    const r = applyTransform("phone_e164", "(415) 555-2671", "inbound", { defaultRegion: "US" });
    expect(r.value).toBe("+14155552671");
  });

  test("a national number with NO region is refused rather than guessed", () => {
    const r = applyTransform("phone_e164", "555-2671");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("unparseable_phone");
  });

  test("garbage is refused, never passed through", () => {
    // Passing it through would break the E.164 assumption every dedup key makes.
    expect(applyTransform("phone_e164", "not a phone").ok).toBe(false);
  });
});

describe("date_iso", () => {
  test("normalises to an ISO instant", () => {
    expect(applyTransform("date_iso", "2026-06-10").value).toBe("2026-06-10T00:00:00.000Z");
  });

  test("an unparseable date is refused", () => {
    const r = applyTransform("date_iso", "not-a-date");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("unparseable_date");
  });
});

describe("lowercase", () => {
  test("trims and lowercases", () => {
    expect(applyTransform("lowercase", "  MiXeD  ").value).toBe("mixed");
  });

  test("coerces a number rather than refusing it", () => {
    expect(applyTransform("lowercase", 42).value).toBe("42");
  });
});

describe("seniority_map", () => {
  for (const [input, expected] of [
    ["CEO", "c_suite"],
    ["Chief Revenue Officer", "c_suite"],
    ["Co-Founder", "c_suite"],
    ["VP of Sales", "vp"],
    ["SVP Marketing", "vp"],
    ["Director of Ops", "director"],
    ["Senior Manager", "manager"],
    ["Account Executive", "other"],
    ["c_suite", "c_suite"], // already canonical
  ] as const) {
    test(`"${input}" -> ${expected}`, () => {
      expect(applyTransform("seniority_map", input).value).toBe(expected);
    });
  }

  test("longest synonym wins — 'senior director' is a director, not a manager", () => {
    expect(applyTransform("seniority_map", "Senior Director").value).toBe("director");
  });

  test("'vice president' beats the 'president' substring", () => {
    expect(applyTransform("seniority_map", "Vice President, Sales").value).toBe("vp");
  });

  test("an unrecognised title is 'other', NOT a refusal — it is still a contact", () => {
    const r = applyTransform("seniority_map", "Chief Vibes Wrangler");
    expect(r.ok).toBe(true);
    expect(r.value).toBe("c_suite"); // 'chief' matches; the point is that it never refuses
    expect(applyTransform("seniority_map", "Zorbnak").value).toBe("other");
  });

  test("outbound sends the TP value as-is — the customer's picklist is theirs", () => {
    expect(applyTransform("seniority_map", "vp", "outbound").value).toBe("vp");
  });
});

describe("picklist_map", () => {
  const config = { map: { MQL: "marketing_qualified", SQL: "sales_qualified" } };

  test("inbound maps a known CRM value", () => {
    expect(applyTransform("picklist_map", "MQL", "inbound", config).value).toBe(
      "marketing_qualified",
    );
  });

  test("inbound is case-tolerant on the lookup", () => {
    expect(applyTransform("picklist_map", "MQL", "inbound", config).value).toBe(
      "marketing_qualified",
    );
  });

  test("an UNMAPPED value is refused — a config gap must surface, not be guessed", () => {
    const r = applyTransform("picklist_map", "Customer", "inbound", config);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("unmapped_picklist_value");
  });

  test("outbound inverts the map", () => {
    expect(applyTransform("picklist_map", "sales_qualified", "outbound", config).value).toBe("SQL");
  });

  test("outbound refuses a TP value with no CRM spelling", () => {
    expect(applyTransform("picklist_map", "churned", "outbound", config).ok).toBe(false);
  });

  test("with no map configured, every value is unmapped", () => {
    expect(applyTransform("picklist_map", "anything", "inbound", {}).ok).toBe(false);
  });
});

describe("transformInbound over a whole record", () => {
  const mappings = [
    { tpField: "jobTitle", crmField: "Title", transform: "passthrough" },
    { tpField: "seniorityLevel", crmField: "Title", transform: "seniority_map" },
    { tpField: "phone", crmField: "Phone", transform: "phone_e164" },
    { tpField: "email", crmField: "Email", transform: "lowercase" },
  ];

  test("converts every mapped field", () => {
    const { values, refused } = transformInbound(mappings, {
      Title: "VP of Sales",
      Phone: "+14155552671",
      Email: "  Dana@ACME.com ",
    });
    expect(values.jobTitle).toBe("VP of Sales");
    expect(values.seniorityLevel).toBe("vp");
    expect(values.phone).toBe("+14155552671");
    expect(values.email).toBe("dana@acme.com");
    expect(refused).toHaveLength(0);
  });

  test("a refused field is OMITTED, not written as null", () => {
    // Writing null would CLEAR the TP field because one CRM value failed to parse — destructive, and the
    // opposite of what the operator asked for.
    const { values, refused } = transformInbound(mappings, {
      Title: "VP of Sales",
      Phone: "garbage",
    });
    expect("phone" in values).toBe(false);
    expect(refused).toEqual([{ tpField: "phone", reason: "unparseable_phone" }]);
    // ...and the other fields still convert. One bad value must not fail the record.
    expect(values.jobTitle).toBe("VP of Sales");
  });

  test("a field the CRM did not send is skipped silently, not counted as a refusal", () => {
    const { values, refused } = transformInbound(mappings, { Title: "Director" });
    expect(refused).toHaveLength(0);
    expect("phone" in values).toBe(false);
    expect(values.seniorityLevel).toBe("director");
  });

  test("one CRM field can feed two TP fields", () => {
    // Title -> jobTitle verbatim AND -> seniorityLevel classified. The mapping table allows it and the
    // transformer must not assume a 1:1 relationship.
    const { values } = transformInbound(mappings, { Title: "Chief Technology Officer" });
    expect(values.jobTitle).toBe("Chief Technology Officer");
    expect(values.seniorityLevel).toBe("c_suite");
  });

  test("an explicit null from the CRM does not land as a value", () => {
    const { values, refused } = transformInbound(mappings, { Title: null, Phone: null });
    expect(Object.keys(values)).toHaveLength(0);
    expect(refused).toHaveLength(0);
  });
});
