# coord-bus — a coordination bus for multiple Claude Code terminals

A tiny **remote MCP server** that lets several Claude Code sessions (on the same or different
machines) share a **task board** and an **inbox**, so they can coordinate and nudge each other while
working the same repo. One session acts as **lead** (plans, assigns); the others **claim** tasks and
report progress. It is developer tooling — it lives outside the product workspaces and is invisible
to the architecture map / dependency-cruiser.

> **What it is and isn't.** This is a *shared blackboard*, not remote control. An agent can leave a
> task or a nudge for another; the other agent acts on it only when *its* loop next reads the bus
> (MCP tools are pull, not push). Keep each terminal moving (see the `/loop` poller below) and it
> feels collaborative. No agent can preempt or puppet another — by design.

## Tools exposed

| Tool | What it does |
|------|--------------|
| `register_agent` | Announce yourself (name + role). Call at startup and as a heartbeat. |
| `get_board` | Snapshot: all agents, all tasks + states, your unread count. |
| `create_task` | Add a task; optionally assign it, declare owned `files`, and `dependsOn`. |
| `claim_task` | Take an unowned task (fails if owned or blocked by unfinished deps). |
| `update_task` | Set state (`pending`→`claimed`→`in_progress`→`blocked`/`done`) + add a note. |
| `nudge` | Message a teammate by name, or `"all"`. |
| `read_inbox` | Read (and mark read) messages addressed to you. |

State persists to a single JSON file (`COORD_STATE`, default `./coord-state.json`).

---

## 1. Run the bus (on the always-on host machine)

```bash
cd tools/coord-bus
bun install
cp .env.example .env        # then set MCP_BEARER_TOKEN (generate: openssl rand -hex 32)
bun run server.ts           # Bun auto-loads .env; prints: coord-bus listening on http://0.0.0.0:7333/mcp
```

Health check: `curl http://localhost:7333/health` → `{"ok":true,...}`.

*Node instead of Bun?* `npm install` then `npx tsx server.ts` — but Node doesn't auto-load `.env`,
so prefix the vars (`MCP_BEARER_TOKEN=... PORT=7333 npx tsx server.ts`) or use `node --env-file=.env`.

Leave it running (a `tmux`/`screen`/Windows service, or just a dedicated terminal).

## 2. Make it reachable by the other terminals

**Same LAN** — the server already binds `0.0.0.0`. Use the host's LAN IP and open the port:

```powershell
# Windows host: allow inbound 7333 (run once, elevated)
New-NetFirewallRule -DisplayName "coord-bus 7333" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 7333
```

URL for clients: `http://<HOST_LAN_IP>:7333/mcp`

**Across the internet / different networks** — front it with a tunnel (gives an HTTPS URL, no
firewall/port-forward):

```bash
cloudflared tunnel --url http://localhost:7333      # prints https://<random>.trycloudflare.com
# or:  ngrok http 7333
```

URL for clients: `https://<your-tunnel-host>/mcp`  (note the `/mcp` path)

## 3. Connect each Claude Code terminal (all three, including the lead)

```bash
claude mcp add --transport http coordinator <URL-from-step-2> \
  --header "Authorization: Bearer <YOUR_TOKEN>" \
  --scope user
```

`--scope user` makes it available in all your projects on that machine. Verify with `claude mcp list`
and `/mcp` inside Claude Code. HTTP servers connect automatically — no restart needed.

**Recommended:** so the 7 coordination tools are always in context (not deferred behind Tool Search),
edit that server's entry in `~/.claude.json` and add `"alwaysLoad": true`. This makes agents reliably
reach for the bus without a lookup step.

## 4. Kick off each terminal

Paste this into each session once, substituting the name (`lead`, `worker-a`, `worker-b`):

> You are agent **worker-a** on a shared coordination bus (MCP server `coordinator`). Protocol:
> at the **start of every task** and every few steps, call `get_board` (agent: `worker-a`) and
> `read_inbox` (agent: `worker-a`) and act on any nudges. Before editing code, `claim_task` the
> relevant task (or `create_task` then claim) and **only edit files your task owns**; if you must
> touch a file another agent owns, `nudge` them first and wait. Post progress with `update_task`;
> when done, set it `done` and `nudge` whoever's next. Work in **your own git worktree/branch** so
> we never overwrite each other. Register now: call `register_agent` (name: `worker-a`, role: ...).

The **lead** additionally creates and assigns tasks (`create_task` with `assignee`/`files`/`dependsOn`)
and integrates branches.

## 5. (Optional) keep idle terminals responsive

A finished agent won't see new nudges until it acts again. Run a poller in each worker so nudges land
within a bounded time:

```
/loop 2m As worker-a, call read_inbox and get_board on the coordinator; act on any nudge or claim the next unblocked task. If nothing to do, say so briefly.
```

---

## Coordinate code through git, coordinate *work* through the bus

The bus carries **who's-doing-what** (tasks, ownership, nudges). The **code** still moves through your
shared git remote. Give each terminal its **own worktree** so concurrent edits can't clobber:

```bash
git worktree add ../DuskWolf-worker-a -b work/worker-a
git worktree add ../DuskWolf-worker-b -b work/worker-b
```

Each worker works in its worktree, commits small, pushes; the lead merges. Declaring `files` on each
task is how you keep lanes disjoint.

## Security

- The bearer token is the **only** gate, especially behind a public tunnel — treat it like a secret,
  keep it in `.env` (gitignored), rotate by changing it + re-running `claude mcp add` everywhere.
- Don't put real secrets/PII in nudges or task notes; this store is plaintext JSON.
- Prefer a tunnel (HTTPS) over raw LAN HTTP if the network isn't fully trusted.

## Ops

- **Reset the board:** stop the server, delete `coord-state.json`, restart.
- **Inspect:** the state file is human-readable JSON.
- **Transport note:** runs in **stateless** Streamable-HTTP mode (POST-only; `GET`/`DELETE` → 405),
  which is all our pull-based model needs. To switch to session-based mode (server push), give the
  transport a `sessionIdGenerator` and keep a per-session transport map — see `server.ts`.
