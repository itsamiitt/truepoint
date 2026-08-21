// problemMessage.ts — turn an RFC 9457 problem response into the sentence a user reads (audit 32 · F4).
//
// This existed as 24 byte-identical private copies, one per feature slice. That is not a style problem: this
// function decides what the app SAYS when something fails, so any improvement to it — honoring a new problem
// field, special-casing a status, tightening the fallback — previously reached one slice out of twenty-four,
// and the app would explain the same failure differently depending on which screen you were on.
//
// The API contract it reads is fixed (apps/api middleware/error.ts): `detail` is the specific, human-facing
// sentence and `title` is the generic one, so preferring detail→title→fallback is the right precedence.

/** The subset of an RFC 9457 problem body this cares about; anything else on the body is ignored. */
interface ProblemBody {
  detail?: string;
  title?: string;
}

/**
 * The best human-readable message for a failed response.
 *
 * Falls back to `<fallback> (<status>)` when the body is absent or unparseable — which is the case for a
 * gateway error or a network-level failure that never reached the API. Keeping the status in that string is
 * deliberate: it is the only signal left to distinguish "you are logged out" from "the server is down" when
 * there is no problem body to read.
 */
export async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as ProblemBody | null;
  return problemMessageFromBody(body, fallback, res.status);
}

/**
 * The same precedence, for callers that have ALREADY read the body.
 *
 * A slice that throws a typed `ApiError` needs `code` and the extension fields off the same body, and a
 * Response can only be read once — so those callers were each re-deriving detail→title→fallback by hand,
 * which is exactly the drift this module exists to stop. They call this instead; `problemMessage` above is
 * now a thin wrapper over it, so there is still ONE implementation of the precedence.
 */
export function problemMessageFromBody(
  body: ProblemBody | null,
  fallback: string,
  status: number,
): string {
  return body?.detail ?? body?.title ?? `${fallback} (${status})`;
}
