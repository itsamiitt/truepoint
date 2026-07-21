// types.ts — the Review slice's view model. Mirrors the forge-api `/bff/review-tasks` payload; the console owns
// no schema of record.

export interface ReviewTask {
  id: string;
  captureId: string;
  reason: string;
  priority: string;
  assignedTo?: string | null;
  createdAt: string;
}

export interface ReviewTasksResponse {
  tasks: ReviewTask[];
}
