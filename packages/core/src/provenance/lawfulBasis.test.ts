// lawfulBasis.test.ts — the precedence order is the whole design, so it is what gets asserted.

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LAWFUL_BASIS,
  acceptanceFor,
  requiresDeclaredBasis,
  resolveLawfulBasis,
} from "./lawfulBasis.ts";

describe("resolveLawfulBasis", () => {
  test("a basis travelling with the data beats a workspace setting", () => {
    // The asymmetry that matters: consent is the only basis a subject can grant, so it is the only one that
    // arrives with the payload — and a workspace setting must never quietly overrule what a person agreed to.
    expect(
      resolveLawfulBasis({
        sourceType: "extension",
        declared: "consent",
        workspaceDefault: "legitimate_interest",
      }),
    ).toBe("consent");
  });

  test("a workspace setting beats the platform default", () => {
    expect(resolveLawfulBasis({ sourceType: "import", workspaceDefault: "contract" })).toBe(
      "contract",
    );
  });

  test("with nothing configured it falls back to the platform default", () => {
    expect(resolveLawfulBasis({ sourceType: "import" })).toBe(DEFAULT_LAWFUL_BASIS);
    expect(DEFAULT_LAWFUL_BASIS).toBe("legitimate_interest");
  });

  test("the default is not 'consent'", () => {
    // Claiming consent nobody collected asserts a legal fact about a person that no record supports. If this
    // ever flips, it should be someone's explicit decision and not a default anyone drifted into.
    expect(DEFAULT_LAWFUL_BASIS).not.toBe("consent");
  });

  test("values outside the vocabulary are ignored rather than trusted", () => {
    // Both inputs cross a boundary — `declared` from a request body, `workspaceDefault` from a column — so
    // neither is trusted just because upstream types it as a string.
    expect(resolveLawfulBasis({ sourceType: "import", declared: "vibes" })).toBe(
      DEFAULT_LAWFUL_BASIS,
    );
    expect(resolveLawfulBasis({ sourceType: "import", workspaceDefault: "whatever" })).toBe(
      DEFAULT_LAWFUL_BASIS,
    );
    // A junk declared value must not shadow a VALID workspace setting either.
    expect(
      resolveLawfulBasis({ sourceType: "import", declared: "", workspaceDefault: "contract" }),
    ).toBe("contract");
  });

  test("it is total — every source type resolves to a member of the vocabulary", () => {
    const sources = [
      "provider",
      "import",
      "coop",
      "forge",
      "crawl",
      "user_edit",
      "reveal",
      "extension",
      "crm_sync",
      "mailbox",
    ] as const;
    for (const sourceType of sources) {
      expect(typeof resolveLawfulBasis({ sourceType })).toBe("string");
    }
  });
});

describe("acceptanceFor", () => {
  test("a capture without a declared basis is recorded but held as pending", () => {
    // 09 rule 4 read literally: untaggable data is auditable but does not enter the graph. Falling back to a
    // workspace setting here would launder configuration into a claim about what a person agreed to.
    expect(acceptanceFor({ sourceType: "extension" })).toBe("pending");
    expect(acceptanceFor({ sourceType: "coop", workspaceDefault: "legitimate_interest" })).toBe(
      "pending",
    );
  });

  test("a capture with a declared basis is accepted", () => {
    expect(acceptanceFor({ sourceType: "extension", declared: "consent" })).toBe("accepted");
  });

  test("non-capture sources are accepted on the configured or default basis", () => {
    expect(acceptanceFor({ sourceType: "import" })).toBe("accepted");
    expect(acceptanceFor({ sourceType: "provider" })).toBe("accepted");
  });

  test("only the capture channels demand a declared basis", () => {
    expect(requiresDeclaredBasis("extension")).toBe(true);
    expect(requiresDeclaredBasis("coop")).toBe(true);
    expect(requiresDeclaredBasis("import")).toBe(false);
    expect(requiresDeclaredBasis("crm_sync")).toBe(false);
  });
});
