// Client-side bus helper used by content scripts and the UI surfaces to talk to the service worker
// with full type inference (request type → response type). Also a broadcast subscription helper.
import type { BroadcastMessage, RequestMessage, ResponseFor } from "./messages.ts";

export async function send<M extends RequestMessage>(msg: M): Promise<ResponseFor<M["type"]>> {
  return (await chrome.runtime.sendMessage(msg)) as ResponseFor<M["type"]>;
}

export function onBroadcast(handler: (msg: BroadcastMessage) => void): () => void {
  const listener = (raw: unknown): void => {
    if (raw && typeof raw === "object" && "type" in raw) {
      const type = (raw as { type: unknown }).type;
      if (type === "STATE_CHANGED" || type === "SUBJECT_STATUS") {
        handler(raw as BroadcastMessage);
      }
    }
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
