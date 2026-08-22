// openapi.ts — the callable contract as an OpenAPI 3.1 document.
//
// The machine reference (machineReference.ts) is for a reader — a person or an assistant — that consumes
// prose. This one is for a TOOL: client generators, Postman, a mock server, an editor's request runner.
// Both are generated from the same typed content, so neither can drift from the pages or from each other.
//
// ONE RULE MAKES THIS DIFFERENT FROM THE PROSE DOCUMENT: a planned endpoint is EXCLUDED, not marked. The
// machine reference can say "planned — NOT callable yet" in a sentence and be understood. A spec has no such
// register: everything in `paths` is, by definition, a callable operation, and the moment one appears there
// somebody generates a client, ships it, and gets a 404 from a route that was never built. Documenting an
// intention is honest; emitting a client stub for it is not. The document says in its own description which
// endpoints were withheld and where to read about them.

import { ENDPOINTS } from "./endpoints/index.ts";
import { ERROR_TYPE_BASE } from "./endpoints/shared.ts";
import { API_BASE_URL, SITE_ORIGIN } from "./site.ts";
import type { Endpoint, ErrorSpec, FieldSpec } from "./types.ts";

/** The path the generated document is served from. */
export const OPENAPI_PATH = "/openapi.json";

/** OpenAPI 3.1 is JSON Schema 2020-12, so a nullable type is a type UNION — not the 3.0 `nullable: true`. */
type JsonSchema = Record<string, unknown>;

function scalarSchema(type: string): JsonSchema {
  const nullable = type.includes("| null");
  const base = type.replace("| null", "").trim();

  if (base.endsWith("[]")) {
    const items = scalarSchema(base.slice(0, -2));
    return nullable ? { type: ["array", "null"], items } : { type: "array", items };
  }

  const primitive = base === "boolean" ? "boolean" : base === "number" ? "number" : "string";
  return { type: nullable ? [primitive, "null"] : primitive };
}

/**
 * Turn the flat, dotted return-field list into a nested schema.
 *
 * The content modules describe returns as `company.domain`, `company.name`, … because that is how a reader
 * scans a table. A generator needs the shape those dots imply, so the grouping happens here rather than by
 * asking every endpoint spec to be written twice.
 *
 * The parent of a group is typed `object | null` on purpose: the one branch every caller of these endpoints
 * has to handle is the miss, where `company` is null and `matched` is false.
 */
function responseSchema(fields: readonly FieldSpec[]): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const groups = new Map<string, FieldSpec[]>();

  for (const field of fields) {
    const dot = field.name.indexOf(".");
    if (dot === -1) {
      properties[field.name] = { ...scalarSchema(field.type), description: field.description };
      continue;
    }
    const parent = field.name.slice(0, dot);
    const child = { ...field, name: field.name.slice(dot + 1) };
    const existing = groups.get(parent);
    if (existing) existing.push(child);
    else groups.set(parent, [child]);
  }

  for (const [parent, children] of groups) {
    properties[parent] = {
      type: ["object", "null"],
      description: "Null when nothing matched — see `matched`.",
      properties: Object.fromEntries(
        children.map((child) => [
          child.name,
          { ...scalarSchema(child.type), description: child.description },
        ]),
      ),
    };
  }

  return { type: "object", properties };
}

function problemResponse(error: ErrorSpec): JsonSchema {
  return {
    description: `${error.code} — ${error.meaning}`,
    content: {
      "application/problem+json": {
        schema: { $ref: "#/components/schemas/Problem" },
        example: {
          type: `${ERROR_TYPE_BASE}${error.code}`,
          title: error.meaning.split(".")[0],
          status: error.status,
          code: error.code,
        },
      },
    },
  };
}

function operation(endpoint: Endpoint): JsonSchema {
  const billable = endpoint.credits > 0;

  const parameters: JsonSchema[] = [];
  if (endpoint.method === "GET") {
    for (const param of endpoint.params) {
      parameters.push({
        name: param.name,
        in: "query",
        required: param.required,
        description: param.description,
        schema: scalarSchema(param.type),
      });
    }
  }
  if (billable) {
    // Not inferred from prose: idempotency is a property of a request that spends money, and every billable
    // endpoint here accepts the header. A generator that omits it produces a client which double-charges on
    // a timeout, which is the single most expensive mistake this contract can lead someone into.
    parameters.push({
      name: "Idempotency-Key",
      in: "header",
      required: false,
      description:
        "A unique key per unit of work. Retrying with the same key replays the stored response and charges nothing.",
      schema: { type: "string" },
    });
  }

  const responses: Record<string, JsonSchema> = {
    "200": {
      description: "The lookup ran. Check `matched` — a miss is a normal 200, never a 404.",
      content: {
        "application/json": {
          schema: responseSchema(endpoint.returns),
          example: JSON.parse(endpoint.example.response),
        },
      },
    },
  };
  for (const error of endpoint.errors) {
    responses[String(error.status)] = problemResponse(error);
  }

  const body =
    endpoint.method === "POST"
      ? {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: endpoint.params.filter((p) => p.required).map((p) => p.name),
                  properties: Object.fromEntries(
                    endpoint.params.map((param) => [
                      param.name,
                      { ...scalarSchema(param.type), description: param.description },
                    ]),
                  ),
                },
              },
            },
          },
        }
      : {};

  return {
    operationId: endpoint.slug.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()),
    summary: endpoint.title,
    description: `${endpoint.summary}\n\n${endpoint.billing}`,
    externalDocs: {
      description: "Reference page",
      url: `${SITE_ORIGIN}/docs/api/${endpoint.slug}`,
    },
    // Not part of the OpenAPI vocabulary, so it rides as an extension: a generator ignores it, and a human
    // reading the raw document still learns the contract is in beta before they depend on it.
    "x-availability": endpoint.availability,
    "x-credits": endpoint.credits,
    security: [{ bearerAuth: ["search:read"] }],
    ...(parameters.length ? { parameters } : {}),
    ...body,
    responses,
  };
}

/** The endpoints a client may actually call today. */
export function callableEndpoints(): readonly Endpoint[] {
  return ENDPOINTS.filter((endpoint) => endpoint.availability !== "planned");
}

/** The endpoints deliberately withheld from the spec, so the document can name them rather than hide them. */
export function withheldEndpoints(): readonly Endpoint[] {
  return ENDPOINTS.filter((endpoint) => endpoint.availability === "planned");
}

/**
 * Build the OpenAPI document.
 *
 * Pure and deterministic — the route serving it is prerendered, and a test asserts two builds are identical.
 */
export function buildOpenApiDocument(): JsonSchema {
  const callable = callableEndpoints();
  const withheld = withheldEndpoints();

  const paths: Record<string, JsonSchema> = {};
  for (const endpoint of callable) {
    // The server URL already carries the /api/v1/public prefix, so a path here is relative to it — an
    // absolute path plus a prefixed server would send a generated client to /api/v1/public/api/v1/public/…
    const relative = endpoint.path.replace("/api/v1/public", "");
    const method = endpoint.method.toLowerCase();
    paths[relative] = { ...(paths[relative] ?? {}), [method]: operation(endpoint) };
  }

  const withheldNote = withheld.length
    ? `\n\nNot in this document: ${withheld
        .map((endpoint) => `${endpoint.method} ${endpoint.path}`)
        .join(
          ", ",
        )}. Those are documented but not callable yet, and a spec has no way to say "planned" that a client generator would respect — it would emit a stub that 404s. They are described at ${SITE_ORIGIN}/docs and will appear here on the day they ship.`
    : "";

  return {
    openapi: "3.1.0",
    info: {
      title: "TruePoint Data API",
      version: "1",
      summary: "Company data by API, priced by usage, with provenance on every field.",
      description: `The public TruePoint data API. Every endpoint in this document is callable today.${withheldNote}\n\nHuman documentation: ${SITE_ORIGIN}/docs · Plain-text reference for assistants: ${SITE_ORIGIN}/llms.txt`,
      contact: { name: "TruePoint", url: `${SITE_ORIGIN}/docs` },
    },
    servers: [{ url: API_BASE_URL, description: "Production" }],
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "A workspace API key, sent as `Authorization: Bearer <key>`. It is a server-side credential — never ship one to a browser or any client a user controls.",
        },
      },
      schemas: {
        Problem: {
          type: "object",
          description:
            "An RFC 9457 problem document. Branch on `code`, never on `title` — titles are prose and may be reworded.",
          required: ["type", "title", "status", "code"],
          properties: {
            type: { type: "string", format: "uri" },
            title: { type: "string" },
            status: { type: "integer" },
            code: { type: "string" },
            detail: { type: "string" },
            requestId: { type: "string" },
            retryAfterSeconds: { type: "integer" },
            balance: { type: "integer" },
            required: { type: "integer" },
          },
        },
      },
    },
  };
}

/** The document as the bytes the route serves: stable key order, two-space indent, one trailing newline. */
export function renderOpenApiJson(): string {
  return `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
}
