// Presentation only. No business logic, no API/DB calls — those live in the service/hook.
// This component reads state from the hook and renders it.

import { useExamples } from "../hooks/useExample";
import { formatExampleLabel } from "../utils/format";

export function ExampleView() {
  const { examples, loading, error } = useExamples();

  if (loading) return <p>Loading…</p>;
  if (error) return <p role="alert">{error}</p>;

  return (
    <ul>
      {examples.map((example) => (
        <li key={example.id}>{formatExampleLabel(example)}</li>
      ))}
    </ul>
  );
}
