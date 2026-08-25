"use client";

// AssistantContext.tsx — holds whether the support assistant is open, and renders it once for the whole site.
//
// It lives in the shared component tree rather than inside features/assistant because two different places
// open the panel: the launcher the assistant renders itself, and the "Ask the assistant" button at the foot
// of the docs rail, which features/api-reference renders. A feature importing another feature is exactly what
// `bun run lint:cross-feature` exists to stop — two destinations meant to ship independently, quietly coupled
// — so the seam between them belongs here, where both may reach it. The panel itself stays in its feature.
//
// A context rather than a DOM event bus, which would work and would be less code: an event is invisible to
// the type system and to anyone grepping for callers. `useAssistant()` is neither.

import { SupportAssistant } from "@/features/assistant/index.ts";
import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from "react";

interface AssistantApi {
  readonly open: () => void;
}

const AssistantContext = createContext<AssistantApi | null>(null);

/** Opens the support assistant. Throws outside the provider rather than silently doing nothing — a button
 *  that looks live and is inert is worse than a build failure. */
export function useAssistant(): AssistantApi {
  const api = useContext(AssistantContext);
  if (!api) throw new Error("useAssistant must be used inside AssistantProvider");
  return api;
}

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const api = useMemo<AssistantApi>(() => ({ open }), [open]);

  return (
    <AssistantContext.Provider value={api}>
      {children}
      <SupportAssistant open={isOpen} onOpen={open} onClose={close} />
    </AssistantContext.Provider>
  );
}
