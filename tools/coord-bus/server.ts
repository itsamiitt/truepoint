// server.ts — the coordination bus: a remote MCP server (Streamable HTTP) that several Claude Code
// terminals connect to as clients to share a task board + inboxes and nudge each other.
//
// Transport: Streamable HTTP, STATELESS mode (a fresh server+transport per POST). Our coordination
// model is fully pull-based — agents call get_board / read_inbox — so we never push server-initiated
// notifications, which makes stateless the simplest robust shape. GET/DELETE therefore return 405.
// Auth: a static shared bearer token, checked (constant-time) in front of the MCP handler.
//
// Run:  MCP_BEARER_TOKEN=... PORT=7333 bun run server.ts   (or: npx tsx server.ts under Node)

import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import * as z from "zod/v4";
import * as store from "./store.ts";

const TOKEN = process.env.MCP_BEARER_TOKEN ?? "";
const PORT = Number(process.env.PORT ?? 7333);

if (!TOKEN) {
  console.error("Refusing to start: MCP_BEARER_TOKEN is not set (the bus must be authenticated).");
  process.exit(1);
}

/** Wrap any JSON-serializable value as an MCP text result. */
function ok(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/** Build a fresh MCP server with the coordination toolset (one per request in stateless mode). */
function buildServer(): McpServer {
  const server = new McpServer({ name: "coord-bus", version: "1.0.0" }, { capabilities: {} });

  server.registerTool(
    "register_agent",
    {
      title: "Register agent",
      description:
        "Announce yourself to the team. Call once at startup, and periodically as a heartbeat. Returns the current board.",
      inputSchema: { name: z.string(), role: z.string().optional() },
    },
    async ({ name, role }) => ok(await store.registerAgent(name, role ?? "")),
  );

  server.registerTool(
    "get_board",
    {
      title: "Get board",
      description:
        "Situational snapshot: every agent, every task with its state, and (if you pass your name) your unread message count. Call at the start of each task and whenever you need to see what the team is doing.",
      inputSchema: { agent: z.string().optional() },
    },
    async ({ agent }) => {
      if (agent) await store.touch(agent);
      return ok(store.board(agent));
    },
  );

  server.registerTool(
    "create_task",
    {
      title: "Create task",
      description:
        "Add a task to the shared board. Optionally assign it to a specific agent, declare the files it owns, and list task ids it depends on.",
      inputSchema: {
        title: z.string(),
        description: z.string().optional(),
        files: z.array(z.string()).optional(),
        assignee: z.string().optional(),
        dependsOn: z.array(z.string()).optional(),
        createdBy: z.string(),
      },
    },
    async (args) => ok(await store.createTask(args)),
  );

  server.registerTool(
    "claim_task",
    {
      title: "Claim task",
      description:
        "Take ownership of a task. Fails if it is already owned by another agent or blocked by unfinished dependencies.",
      inputSchema: { taskId: z.string(), agent: z.string() },
    },
    async ({ taskId, agent }) => ok(await store.claimTask(taskId, agent)),
  );

  server.registerTool(
    "update_task",
    {
      title: "Update task",
      description:
        "Change a task's state (pending | claimed | in_progress | blocked | done) and/or append a progress note.",
      inputSchema: {
        taskId: z.string(),
        agent: z.string(),
        state: z.enum(["pending", "claimed", "in_progress", "blocked", "done"]).optional(),
        note: z.string().optional(),
      },
    },
    async ({ taskId, agent, state, note }) =>
      ok(await store.updateTask(taskId, agent, { state, note })),
  );

  server.registerTool(
    "nudge",
    {
      title: "Nudge",
      description:
        'Send a message to a teammate by name, or to "all". They receive it the next time they read their inbox.',
      inputSchema: { from: z.string(), to: z.string(), body: z.string() },
    },
    async ({ from, to, body }) => ok(await store.nudge(from, to, body)),
  );

  server.registerTool(
    "read_inbox",
    {
      title: "Read inbox",
      description:
        'Read messages addressed to you (or to "all"); this marks them read. Call it often so you do not miss nudges.',
      inputSchema: { agent: z.string(), unreadOnly: z.boolean().optional() },
    },
    async ({ agent, unreadOnly }) => {
      await store.touch(agent);
      return ok(await store.readInbox(agent, unreadOnly ?? true));
    },
  );

  return server;
}

/** Constant-time bearer-token check, applied in front of every MCP verb. */
function requireBearer(req: Request, res: Response, next: NextFunction): void {
  const [scheme, token] = (req.headers.authorization ?? "").split(" ");
  const a = Buffer.from(token ?? "");
  const b = Buffer.from(TOKEN);
  const authorized = scheme === "Bearer" && a.length === b.length && timingSafeEqual(a, b);
  if (!authorized) {
    res
      .set("WWW-Authenticate", "Bearer")
      .status(401)
      .json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
    return;
  }
  next();
}

const methodNotAllowed = (_req: Request, res: Response): void => {
  res
    .status(405)
    .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
};

const app = express();
app.use(express.json());

// Unauthenticated liveness probe — handy for verifying reachability through a LAN/tunnel.
app.get("/health", (_req, res) => res.json({ ok: true, service: "coord-bus" }));

app.post("/mcp", requireBearer, async (req: Request, res: Response) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless mode: no server->client stream and no session to terminate.
app.get("/mcp", requireBearer, methodNotAllowed);
app.delete("/mcp", requireBearer, methodNotAllowed);

await store.load();
app.listen(PORT, "0.0.0.0", () => {
  console.log(`coord-bus listening on http://0.0.0.0:${PORT}/mcp`);
});
