"use client";

// SupportAssistant.tsx — the floating support assistant, on every page of the portal.
//
// A NON-MODAL disclosure, not a dialog. truepoint-design says overlays are composed from the DS Dialog or
// Drawer so focus is trapped and returned — that rule is about surfaces which take the page over. This one
// must not: the reader's question is usually about the paragraph behind the panel, and trapping focus would
// mean answering "what does enrich cost" by making the pricing page unreachable. So it is the disclosure
// pattern instead, implemented completely: the launcher owns `aria-expanded` and `aria-controls`, the panel
// is a named region, and Escape closes it and returns focus to the launcher. Nothing here is a focus trap
// that skips half of itself, which is what the rule exists to prevent.
//
// Every answer is composed from the content modules (answer.ts). There is no network call — see intents.ts.

import { TpButton, TpIconButton, TpInput } from "@leadwolf/ui";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { SUGGESTIONS, answerFor } from "../answer.ts";
import styles from "../assistant.module.css";
import { AssistantMessage, type Turn } from "./AssistantMessage.tsx";

const GREETING: Turn = {
  id: 0,
  from: "assistant",
  text: "Ask about credits, authentication, retries, the company record, or which endpoints are callable today. Every answer comes from these docs and links back to the page it came from.",
  links: [],
};

export function SupportAssistant({
  open,
  onOpen,
  onClose,
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const panelId = useId();
  const launcherId = useId();
  const logEndRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState<readonly Turn[]>([GREETING]);

  // Addressed by id rather than by ref: TpButton is a plain function component with no ref forwarding, and
  // reaching for the DOM node by id keeps the DS component used as it is published rather than wrapped.
  const focusLauncher = useCallback(() => {
    document.getElementById(launcherId)?.focus();
  }, [launcherId]);

  // Escape closes from anywhere inside the panel and hands focus back to the control that opened it —
  // without this, closing leaves focus on a removed node and the next Tab restarts at the top of the page.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      onClose();
      focusLauncher();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, focusLauncher]);

  useEffect(() => {
    if (open) logEndRef.current?.scrollIntoView({ block: "end" });
  }, [open]);

  function ask(question: string) {
    const asked = question.trim();
    if (!asked) return;
    const answer = answerFor(asked);
    setTurns((current) => [
      ...current,
      { id: current.length, from: "reader", text: asked, links: [] },
      { id: current.length + 1, from: "assistant", text: answer.text, links: answer.links },
    ]);
    setDraft("");
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    ask(draft);
  }

  return (
    <div className={styles.dock}>
      {open ? (
        <section className={styles.panel} id={panelId} aria-label="Support assistant">
          <header className={styles.panelHead}>
            <div>
              <p className={styles.panelTitle}>Support assistant</p>
              <p className={styles.panelSub}>Answers from this documentation</p>
            </div>
            <TpIconButton label="Close the assistant" onClick={onClose}>
              ✕
            </TpIconButton>
          </header>

          {/* polite, not assertive: an answer arriving should be announced after whatever the reader is
              already hearing, never interrupt it. */}
          <div className={styles.log} aria-live="polite">
            {turns.map((turn) => (
              <AssistantMessage key={turn.id} turn={turn} />
            ))}
            <div ref={logEndRef} />
          </div>

          {turns.length === 1 ? (
            <div className={styles.suggestions}>
              {SUGGESTIONS.map((suggestion) => (
                <TpButton
                  key={suggestion}
                  variant="secondary"
                  size="sm"
                  onClick={() => ask(suggestion)}
                >
                  {suggestion}
                </TpButton>
              ))}
            </div>
          ) : null}

          <form className={styles.composer} onSubmit={onSubmit}>
            <TpInput
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Ask about credits, auth, errors…"
              aria-label="Ask the support assistant"
              className={styles.composerField}
            />
            <TpButton type="submit" variant="primary" size="sm">
              Ask
            </TpButton>
          </form>
        </section>
      ) : null}

      <TpButton
        id={launcherId}
        variant="primary"
        onClick={open ? onClose : onOpen}
        aria-expanded={open}
        // Only while the panel exists: aria-controls pointing at an absent id is a broken reference, and a
        // screen reader announces it as one.
        aria-controls={open ? panelId : undefined}
      >
        {open ? "Hide assistant" : "Support assistant"}
      </TpButton>
    </div>
  );
}
