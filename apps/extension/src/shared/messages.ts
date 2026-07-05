// Typed, Zod-validated message contracts between contexts (content script / UI ⇄ service worker).
// Every inbound message is parsed with `requestMessage` before handling (03 §1.8: validate senders +
// schema, drop unknowns). Responses are strongly typed per request via `ResponseFor`.
import { z } from "zod";
import {
  type ErrorClass,
  type RevealType,
  capturedRecord,
  revealType,
  type subjectStatus,
} from "./types.ts";

export const requestMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("PING") }),
  z.object({ type: z.literal("GET_STATE") }),
  z.object({
    type: z.literal("LOOKUP"),
    subjectKey: z.string().min(1),
    sourceUrl: z.string().url(),
  }),
  z.object({ type: z.literal("CAPTURE"), record: capturedRecord }),
  z.object({ type: z.literal("REVEAL"), contactId: z.string().min(1), revealType }),
  z.object({ type: z.literal("AUTH_LOGIN") }),
  z.object({ type: z.literal("AUTH_LOGOUT") }),
  z.object({ type: z.literal("OPEN_PANEL") }),
]);
export type RequestMessage = z.infer<typeof requestMessage>;
export type RequestType = RequestMessage["type"];

export interface AuthState {
  status: "signed_in" | "signed_out";
  account: string | null;
  workspaceId: string | null;
  credits: number | null;
}

export interface AppState {
  auth: AuthState;
  queueDepth: number;
}

export interface LookupResponse {
  status: z.infer<typeof subjectStatus>;
}

export interface CaptureResponse {
  status: z.infer<typeof subjectStatus>;
}

export interface RevealResponse {
  ok: boolean;
  revealType: RevealType;
  email?: string;
  phone?: string;
  errorClass?: ErrorClass;
  message?: string;
}

/** Maps a request `type` to its response shape, so `bus.send()` is fully typed. */
export type ResponseFor<T extends RequestType> = T extends "PING"
  ? { pong: true }
  : T extends "GET_STATE"
    ? AppState
    : T extends "LOOKUP"
      ? LookupResponse
      : T extends "CAPTURE"
        ? CaptureResponse
        : T extends "REVEAL"
          ? RevealResponse
          : T extends "AUTH_LOGIN"
            ? AuthState
            : T extends "AUTH_LOGOUT"
              ? AuthState
              : T extends "OPEN_PANEL"
                ? { ok: boolean }
                : never;

/** SW → surfaces broadcasts (state fan-out; no request/response). */
export type BroadcastMessage =
  | { type: "STATE_CHANGED"; state: AppState }
  | { type: "SUBJECT_STATUS"; subjectKey: string; status: z.infer<typeof subjectStatus> };

/** Narrow a request by type without re-parsing (after `requestMessage.parse`). */
export function isRequestType<T extends RequestType>(
  msg: RequestMessage,
  type: T,
): msg is Extract<RequestMessage, { type: T }> {
  return msg.type === type;
}
