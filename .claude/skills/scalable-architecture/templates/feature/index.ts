// PUBLIC INTERFACE for the Example feature (principle #5).
// Re-export ONLY what other layers (app/, other features via shared/) are allowed to use.
// Everything not listed here is internal — no one may deep-import it.

export { ExampleView } from "./components/ExampleView";
export { useExamples } from "./hooks/useExample";
export type { Example, CreateExampleInput } from "./types";

// Intentionally NOT exported (internal):
//   ./services/exampleService  — call it through useExamples()
//   ./utils/format             — feature-internal helpers
