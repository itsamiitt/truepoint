// openapi.test.ts — the generated spec, held to the rule that makes it safe to publish.
//
// A spec is executable documentation: somebody runs a generator over it and ships the result. That raises the
// cost of every mistake in it above the cost of the same mistake on a page. The assertions below are the ones
// that matter in that light — no operation exists for an endpoint that is not callable, every documented
// failure is present so a generated client has a branch for it, and the security scheme is actually applied
// rather than merely declared.

import { describe, expect, test } from "bun:test";
import { ENDPOINTS } from "./endpoints/index.ts";
import {
  buildOpenApiDocument,
  callableEndpoints,
  renderOpenApiJson,
  withheldEndpoints,
} from "./openapi.ts";

const DOC = buildOpenApiDocument() as {
  openapi: string;
  info: { title: string; version: string; description: string };
  servers: { url: string }[];
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: { securitySchemes: Record<string, unknown>; schemas: Record<string, unknown> };
};

describe("only callable endpoints become operations", () => {
  test("every non-planned endpoint has an operation", () => {
    for (const endpoint of callableEndpoints()) {
      const relative = endpoint.path.replace("/api/v1/public", "");
      expect(DOC.paths[relative]?.[endpoint.method.toLowerCase()]).toBeDefined();
    }
  });

  test("no planned endpoint appears anywhere in paths", () => {
    const serialized = JSON.stringify(DOC.paths);
    for (const endpoint of withheldEndpoints()) {
      const relative = endpoint.path.replace("/api/v1/public", "");
      expect(DOC.paths[relative]).toBeUndefined();
      // Matched on the reference URL, not the bare slug: a slug like "search" is a substring of the
      // `search:read` scope every operation legitimately carries, and asserting on it fails for the wrong
      // reason.
      expect(serialized).not.toContain(`/docs/api/${endpoint.slug}`);
    }
  });

  test("the withheld endpoints are named in the description rather than hidden", () => {
    const withheld = withheldEndpoints();
    if (withheld.length === 0) return;
    for (const endpoint of withheld) {
      expect(DOC.info.description).toContain(endpoint.path);
    }
  });

  test("the fixture this rule exists for still holds — some endpoint IS planned", () => {
    // If every endpoint ships, the exclusion rule stops being exercised and the two tests above pass
    // vacuously. This is the canary for that, not a statement that a planned endpoint is desirable.
    expect(ENDPOINTS.some((endpoint) => endpoint.availability === "planned")).toBe(true);
  });
});

describe("a generated client would be correct", () => {
  test("paths are relative to the server URL, never double-prefixed", () => {
    expect(DOC.servers[0]?.url).toBe("https://api.truepoint.in/api/v1/public");
    for (const path of Object.keys(DOC.paths)) {
      expect(path.startsWith("/")).toBe(true);
      expect(path).not.toContain("/api/v1/public");
    }
  });

  test("every documented error is a response on its operation", () => {
    for (const endpoint of callableEndpoints()) {
      const relative = endpoint.path.replace("/api/v1/public", "");
      const op = DOC.paths[relative]?.[endpoint.method.toLowerCase()] as {
        responses: Record<string, unknown>;
      };
      expect(op.responses["200"]).toBeDefined();
      for (const error of endpoint.errors) {
        expect(op.responses[String(error.status)]).toBeDefined();
      }
    }
  });

  test("a billable operation accepts Idempotency-Key", () => {
    for (const endpoint of callableEndpoints()) {
      if (endpoint.credits === 0) continue;
      const relative = endpoint.path.replace("/api/v1/public", "");
      const op = DOC.paths[relative]?.[endpoint.method.toLowerCase()] as {
        parameters?: { name: string; in: string }[];
      };
      expect(op.parameters?.some((p) => p.name === "Idempotency-Key" && p.in === "header")).toBe(
        true,
      );
    }
  });

  test("the miss branch is expressible — the matched object is nullable", () => {
    const match = DOC.paths["/company/match"]?.get as {
      responses: Record<string, { content: Record<string, { schema: Record<string, unknown> }> }>;
    };
    const schema = match.responses["200"]?.content["application/json"]?.schema as {
      properties: Record<string, { type: unknown }>;
    };
    expect(schema.properties.company?.type).toEqual(["object", "null"]);
    expect(schema.properties.matched?.type).toBe("boolean");
  });

  test("a nullable scalar is a 3.1 type union, not the 3.0 nullable flag", () => {
    const enrich = DOC.paths["/company/enrich"]?.post as {
      responses: Record<string, { content: Record<string, { schema: Record<string, unknown> }> }>;
    };
    const schema = enrich.responses["200"]?.content["application/json"]?.schema as {
      properties: Record<string, { properties?: Record<string, { type: unknown }> }>;
    };
    expect(schema.properties.company?.properties?.website_url?.type).toEqual(["string", "null"]);
    expect(JSON.stringify(DOC)).not.toContain('"nullable"');
  });

  test("every operation carries the bearer requirement, and the scheme is defined", () => {
    expect(DOC.components.securitySchemes.bearerAuth).toBeDefined();
    for (const methods of Object.values(DOC.paths)) {
      for (const op of Object.values(methods)) {
        expect((op as { security: unknown[] }).security.length).toBeGreaterThan(0);
      }
    }
  });

  test("availability rides along as an extension so a raw reader sees it", () => {
    for (const endpoint of callableEndpoints()) {
      const relative = endpoint.path.replace("/api/v1/public", "");
      const op = DOC.paths[relative]?.[endpoint.method.toLowerCase()] as Record<string, unknown>;
      expect(op["x-availability"]).toBe(endpoint.availability);
    }
  });
});

describe("it is safe to prerender", () => {
  test("the rendered JSON is deterministic and parses", () => {
    const first = renderOpenApiJson();
    expect(renderOpenApiJson()).toBe(first);
    expect(() => JSON.parse(first)).not.toThrow();
    expect(first.endsWith("\n")).toBe(true);
  });

  test("it declares OpenAPI 3.1", () => {
    expect(DOC.openapi).toBe("3.1.0");
  });
});
