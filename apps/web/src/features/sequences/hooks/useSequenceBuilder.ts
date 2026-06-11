// useSequenceBuilder.ts — view state for the two-phase create flow: create the sequence shell, then append
// email steps one at a time, keeping a recap of the steps added this session. Each action returns whether
// it succeeded so the form can clear its fields; `onChanged` lets the page refresh the list's counts.
"use client";

import { useCallback, useState } from "react";
import { addSequenceStep, createSequence } from "../api";
import type { CreatedStep, NewSequenceInput, NewStepInput } from "../types";

export function useSequenceBuilder(onChanged: () => void) {
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null);
  const [steps, setSteps] = useState<CreatedStep[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Phase 1 — POST /sequences. On success the builder switches to step-adding mode. */
  const create = useCallback(
    async (input: NewSequenceInput): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        const id = await createSequence(input);
        setCreated({ id, name: input.name });
        setSteps([]);
        onChanged();
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not create sequence");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  /** Phase 2 — POST /sequences/:id/steps; the 201's stepOrder drives the recap list. */
  const addStep = useCallback(
    async (input: NewStepInput): Promise<boolean> => {
      if (!created) return false;
      setBusy(true);
      setError(null);
      try {
        const { id, stepOrder } = await addSequenceStep(created.id, input);
        setSteps((prev) => [
          ...prev,
          { id, stepOrder, subject: input.subject ?? "", delayHours: input.delay_hours ?? 0 },
        ]);
        onChanged();
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not add step");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [created, onChanged],
  );

  /** Close the step-adding phase and reset to a fresh create form. */
  const finish = useCallback(() => {
    setCreated(null);
    setSteps([]);
    setError(null);
  }, []);

  return { created, steps, busy, error, create, addStep, finish };
}
