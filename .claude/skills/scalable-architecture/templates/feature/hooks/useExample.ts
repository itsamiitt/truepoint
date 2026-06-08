// Stateful glue between the UI and the service layer for the Example feature.
// The component stays dumb; this hook owns loading/error/data state and calls the service.

import { useCallback, useEffect, useState } from "react";

import { createExample, listExamples } from "../services/exampleService";
import type { CreateExampleInput, Example } from "../types";

interface UseExamplesState {
  examples: Example[];
  loading: boolean;
  error: string | null;
  add: (input: CreateExampleInput) => Promise<void>;
  reload: () => Promise<void>;
}

export function useExamples(): UseExamplesState {
  const [examples, setExamples] = useState<Example[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listExamples();
      setExamples(result.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load examples");
    } finally {
      setLoading(false);
    }
  }, []);

  const add = useCallback(
    async (input: CreateExampleInput) => {
      await createExample(input);
      await reload();
    },
    [reload],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  return { examples, loading, error, add, reload };
}
