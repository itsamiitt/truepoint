// store.ts — the coordination bus's shared state: agents, tasks, and a message inbox.
// Single-writer (this one server process), so we keep state in memory and persist after every
// mutation with an atomic temp+rename write, serialized through a promise chain. No DB, no native
// deps — adequate and robust for a handful of agents coordinating. Runtime-agnostic (Bun or Node).

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type TaskState = "pending" | "claimed" | "in_progress" | "blocked" | "done";

export interface Agent {
  name: string;
  role: string;
  status: "active";
  registeredAt: string;
  lastSeenAt: string;
}

export interface TaskNote {
  at: string;
  by: string;
  text: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  files: string[];
  assignee: string | null;
  state: TaskState;
  dependsOn: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  notes: TaskNote[];
}

export interface Message {
  id: string;
  from: string;
  to: string; // an agent name, or "all"
  body: string;
  createdAt: string;
  readBy: string[];
}

interface State {
  agents: Record<string, Agent>;
  tasks: Task[];
  messages: Message[];
}

const STATE_PATH = resolve(process.env.COORD_STATE ?? "./coord-state.json");

let state: State = { agents: {}, tasks: [], messages: [] };
let writeChain: Promise<void> = Promise.resolve();

const now = (): string => new Date().toISOString();

/** Load persisted state from disk (called once at startup). */
export async function load(): Promise<void> {
  if (!existsSync(STATE_PATH)) return;
  const parsed = JSON.parse(await readFile(STATE_PATH, "utf8")) as Partial<State>;
  state = {
    agents: parsed.agents ?? {},
    tasks: parsed.tasks ?? [],
    messages: parsed.messages ?? [],
  };
}

/** Atomic, serialized persist. Every mutation awaits this so writes never interleave or tear. */
function persist(): Promise<void> {
  writeChain = writeChain.then(async () => {
    await mkdir(dirname(STATE_PATH), { recursive: true });
    const tmp = `${STATE_PATH}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tmp, STATE_PATH);
  });
  return writeChain;
}

/** A snapshot of the whole board. If `agent` is given, includes that agent's unread count. */
export function board(agent?: string) {
  const unreadMessages =
    agent === undefined
      ? undefined
      : state.messages.filter(
          (m) => (m.to === agent || m.to === "all") && !m.readBy.includes(agent),
        ).length;
  return {
    agents: Object.values(state.agents),
    tasks: state.tasks,
    ...(agent === undefined ? {} : { you: agent, unreadMessages }),
  };
}

/** Bump an agent's last-seen heartbeat (no-op if unknown). */
export async function touch(agent: string): Promise<void> {
  const a = state.agents[agent];
  if (!a) return;
  a.lastSeenAt = now();
  await persist();
}

export async function registerAgent(name: string, role: string) {
  const existing = state.agents[name];
  state.agents[name] = {
    name,
    role: role || existing?.role || "",
    status: "active",
    registeredAt: existing?.registeredAt ?? now(),
    lastSeenAt: now(),
  };
  await persist();
  return board(name);
}

export async function createTask(p: {
  title: string;
  description?: string;
  files?: string[];
  assignee?: string | null;
  dependsOn?: string[];
  createdBy: string;
}): Promise<Task> {
  const task: Task = {
    id: `T-${randomUUID().slice(0, 8)}`,
    title: p.title,
    description: p.description ?? "",
    files: p.files ?? [],
    assignee: p.assignee ?? null,
    state: p.assignee ? "claimed" : "pending",
    dependsOn: p.dependsOn ?? [],
    createdBy: p.createdBy,
    createdAt: now(),
    updatedAt: now(),
    notes: [],
  };
  state.tasks.push(task);
  await persist();
  return task;
}

export async function claimTask(taskId: string, agent: string) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return { ok: false as const, reason: `No task ${taskId}` };
  if (task.assignee && task.assignee !== agent) {
    return { ok: false as const, reason: `Already owned by ${task.assignee}` };
  }
  const unmet = task.dependsOn.filter((id) => {
    const dep = state.tasks.find((t) => t.id === id);
    return !dep || dep.state !== "done";
  });
  if (unmet.length) {
    return {
      ok: false as const,
      reason: `Blocked on unfinished dependencies: ${unmet.join(", ")}`,
    };
  }
  task.assignee = agent;
  task.state = "claimed";
  task.updatedAt = now();
  await touch(agent);
  await persist();
  return { ok: true as const, task };
}

export async function updateTask(
  taskId: string,
  agent: string,
  changes: { state?: TaskState; note?: string },
) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return { ok: false as const, reason: `No task ${taskId}` };
  if (changes.state) task.state = changes.state;
  if (changes.note) task.notes.push({ at: now(), by: agent, text: changes.note });
  task.updatedAt = now();
  await persist();
  return { ok: true as const, task };
}

export async function nudge(from: string, to: string, body: string): Promise<Message> {
  const message: Message = {
    id: `M-${randomUUID().slice(0, 8)}`,
    from,
    to,
    body,
    createdAt: now(),
    readBy: [],
  };
  state.messages.push(message);
  await persist();
  return message;
}

/** Messages addressed to `agent` (or "all"). Marks the returned ones read by `agent`. */
export async function readInbox(agent: string, unreadOnly = true): Promise<Message[]> {
  const mine = state.messages.filter((m) => m.to === agent || m.to === "all");
  const result = unreadOnly ? mine.filter((m) => !m.readBy.includes(agent)) : mine;
  let changed = false;
  for (const m of result) {
    if (!m.readBy.includes(agent)) {
      m.readBy.push(agent);
      changed = true;
    }
  }
  if (changed) await persist();
  return result;
}
