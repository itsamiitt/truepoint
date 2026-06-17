// useSequenceBuilder.ts — view state for the builder Drawer. The rep composes an ordered list of outreach
// steps locally (channel · delay · subject · body), reorders/removes freely, then "Create sequence" persists
// in one flow: POST /sequences (the shell) → POST /sequences/:id/steps for each step in order. Keeping the
// step list local means reorder/remove are instant and never round-trip until save. `onChanged` lets the
// page refresh the list's counts after a successful create. Presentation state only.
"use client";

import { useCallback, useState } from "react";
import { addSequenceStep, createSequence } from "../api";
import type { NewSequenceInput, StepChannel } from "../types";

/** One step the rep is composing in the Drawer (local id; persisted only on Create). */
export interface DraftStep {
  localId: string;
  channel: StepChannel;
  delayHours: number;
  subject: string;
  body: string;
}

let stepSeq = 0;
function nextLocalId(): string {
  stepSeq += 1;
  return `step-${stepSeq}`;
}

/** A fresh email step (the common case); the first step defaults to "send immediately" (0h delay). */
export function makeDraftStep(delayHours = 24): DraftStep {
  return { localId: nextLocalId(), channel: "email", delayHours, subject: "", body: "" };
}

export function useSequenceBuilder(onChanged: () => void) {
  const [steps, setSteps] = useState<DraftStep[]>([makeDraftStep(0)]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addStep = useCallback(() => {
    setSteps((prev) => [...prev, makeDraftStep(prev.length === 0 ? 0 : 24)]);
  }, []);

  const removeStep = useCallback((localId: string) => {
    setSteps((prev) => (prev.length <= 1 ? prev : prev.filter((s) => s.localId !== localId)));
  }, []);

  const updateStep = useCallback((localId: string, patch: Partial<Omit<DraftStep, "localId">>) => {
    setSteps((prev) => prev.map((s) => (s.localId === localId ? { ...s, ...patch } : s)));
  }, []);

  /** Move a step one slot up/down; the list IS the send order so this is the reorder primitive. */
  const moveStep = useCallback((localId: string, dir: -1 | 1) => {
    setSteps((prev) => {
      const i = prev.findIndex((s) => s.localId === localId);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      const a = next[i];
      const b = next[j];
      if (a === undefined || b === undefined) return prev;
      next[i] = b;
      next[j] = a;
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setSteps([makeDraftStep(0)]);
    setError(null);
    setBusy(false);
  }, []);

  /**
   * Persist the whole builder: create the shell, then append each step in list order. Email steps post a
   * body; LinkedIn steps are human-in-the-loop and aren't auto-sent, but the step is still recorded so the
   * rep sees it in the sequence. Returns whether the create fully succeeded.
   */
  const submit = useCallback(
    async (shell: NewSequenceInput): Promise<boolean> => {
      const composed = steps.filter((s) => s.body.trim().length > 0);
      if (composed.length === 0) {
        setError("Add at least one step with body copy before creating the sequence.");
        return false;
      }
      setBusy(true);
      setError(null);
      try {
        const id = await createSequence(shell);
        for (const step of composed) {
          await addSequenceStep(id, {
            channel: step.channel,
            delay_hours: Math.max(0, Math.round(step.delayHours)),
            ...(step.subject.trim() ? { subject: step.subject.trim() } : {}),
            body: step.body.trim(),
          });
        }
        onChanged();
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not create the sequence");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [steps, onChanged],
  );

  return { steps, busy, error, addStep, removeStep, updateStep, moveStep, reset, submit };
}
