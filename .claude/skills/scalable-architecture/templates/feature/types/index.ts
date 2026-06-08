// Public + internal types for the Example feature.
// Replace "Example"/"example" with your feature name when scaffolding.

/** A single Example domain object. */
export interface Example {
  id: string;
  name: string;
  createdAt: string; // ISO-8601
}

/** Input accepted when creating an Example. */
export interface CreateExampleInput {
  name: string;
}

/** Result returned by the service layer to the UI. */
export interface ExampleListResult {
  items: Example[];
  total: number;
}
