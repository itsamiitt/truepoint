// Unit tests for the Example service — logic is testable because it lives outside the UI (principle #6).
// Co-located with the feature. Swap the import for your test runner (vitest/jest/bun:test).

import { describe, expect, it, vi } from "vitest";

import { apiClient } from "../../../lib/apiClient";
import { createExample, listExamples } from "../services/exampleService";

vi.mock("../../../lib/apiClient");

describe("exampleService", () => {
  it("returns examples sorted newest-first with a total", async () => {
    vi.mocked(apiClient.get).mockResolvedValue([
      { id: "1", name: "Old", createdAt: "2024-01-01T00:00:00Z" },
      { id: "2", name: "New", createdAt: "2024-06-01T00:00:00Z" },
    ]);

    const result = await listExamples();

    expect(result.total).toBe(2);
    expect(result.items[0].id).toBe("2"); // newest first
  });

  it("rejects an empty name", async () => {
    await expect(createExample({ name: "   " })).rejects.toThrow("required");
  });
});
