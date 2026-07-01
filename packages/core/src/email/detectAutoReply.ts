// detectAutoReply.ts — classify an inbound email as an AUTOMATED reply (out-of-office / vacation / vendor
// autoresponder) vs a genuine HUMAN reply, from its headers (RFC 3834 + common vendor headers). Pure +
// header-driven so it is deterministic and unit-testable; the optional AI classifier (Part C) later refines the
// 'human' bucket. An auto_reply/OOO must NEVER count as a human reply (it doesn't auto-pause the sequence).

/** The classification the inbound recorder stores + acts on (matches email_message.classification, minus
 *  'bounce' which the delivery/bounce path owns). */
export type ReplyClassification = "human" | "auto_reply" | "ooo" | "unknown";

/** Headers as a lowercased-key → value(s) map (the MIME parser hands this in). */
export type InboundHeaders = Record<string, string | string[] | undefined>;

function first(headers: InboundHeaders, key: string): string {
  const v = headers[key.toLowerCase()];
  return (Array.isArray(v) ? v[0] : v)?.toLowerCase() ?? "";
}

const OOO_SUBJECT =
  /out of office|out-of-office|on vacation|away from|automatic reply|auto[- ]?reply|abwesenheit|absence/i;

function looksOoo(headers: InboundHeaders): boolean {
  return OOO_SUBJECT.test(first(headers, "subject"));
}

/**
 * Decide whether an inbound message is automated. RFC 3834: `Auto-Submitted` present and not `no` ⇒ automated.
 * Also honour the widely-used vendor headers (X-Autoreply / X-Auto-Response-Suppress) and a bulk `Precedence`.
 * A subject that reads like an OOO is a secondary signal. Returns the classification the recorder stores.
 */
export function detectAutoReply(headers: InboundHeaders): {
  isAuto: boolean;
  classification: ReplyClassification;
} {
  const autoSubmitted = first(headers, "auto-submitted");
  if (autoSubmitted && autoSubmitted !== "no") {
    return { isAuto: true, classification: looksOoo(headers) ? "ooo" : "auto_reply" };
  }
  if (
    first(headers, "x-autoreply") ||
    first(headers, "x-autorespond") ||
    first(headers, "x-auto-response-suppress")
  ) {
    return { isAuto: true, classification: looksOoo(headers) ? "ooo" : "auto_reply" };
  }
  const precedence = first(headers, "precedence");
  if (precedence === "auto_reply" || precedence === "bulk" || precedence === "junk") {
    return { isAuto: true, classification: "auto_reply" };
  }
  if (looksOoo(headers)) return { isAuto: true, classification: "ooo" };
  return { isAuto: false, classification: "human" };
}
