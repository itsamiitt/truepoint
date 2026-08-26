// answer.ts — route a question to an answer, or to the pages that hold one.
//
// Two stages, and the second is the important one. A keyword intent (intents.ts) answers the dozen questions
// this API actually gets asked. Everything else falls through to the site's own search index — the same
// corpus the masthead combobox reads — and the assistant says plainly that it is pointing rather than
// answering. It never guesses, and it never returns nothing: a question with no intent and no hit still gets
// the list of what this assistant covers.

import { searchDocs } from "../../content/searchIndex.ts";
import { INTENTS } from "./intents.ts";

export interface AnswerLink {
  readonly href: string;
  readonly label: string;
}

export interface Answer {
  readonly text: string;
  readonly links: readonly AnswerLink[];
  /** True when the text is an answer; false when it is a pointer to pages that contain one. */
  readonly grounded: boolean;
}

const FALLBACK_LIMIT = 3;

const COVERAGE =
  "I answer from this documentation: credits and what a call costs, authentication and scopes, the error vocabulary, idempotency and retries, the company record's fields, and which endpoints are callable today. Ask me one of those, or use the search box in the header — it reads the body of every page.";

export function answerFor(question: string): Answer {
  const asked = question.toLowerCase();

  const intent = INTENTS.find((candidate) =>
    candidate.keywords.some((keyword) => asked.includes(keyword)),
  );
  if (intent) {
    return {
      text: intent.answer,
      links: [{ href: intent.href, label: intent.hrefLabel }],
      grounded: true,
    };
  }

  const hits = searchDocs(question, FALLBACK_LIMIT);
  if (hits.length > 0) {
    return {
      text: "I do not have a written answer for that one, but these pages cover it:",
      links: hits.map((hit) => ({ href: hit.href, label: `${hit.title} · ${hit.section}` })),
      grounded: false,
    };
  }

  return { text: COVERAGE, links: [], grounded: false };
}

/** The openers offered before the reader has typed anything. Each is a question this assistant answers from
 *  an intent, so a first click never lands on the fallback. */
export const SUGGESTIONS: readonly string[] = [
  "What does an enrich call cost?",
  "How do retries avoid a double charge?",
  "Is there a contact endpoint?",
  "Which errors should I handle?",
];
