// ImportJobDrawer - one import job's detail in a drawer, opened from the history table.
//
// `fallback` is the list row the table already has, so the drawer paints immediately with what is known and
// fills in the rest when the detail read lands - rather than showing a spinner over data it already holds.
import { ImportJobDrawer } from "@leadwolf/ui";
import * as D from "./_webData";
import { Stage } from "./_webPage";

const JOBS = D.W.IMPORT_JOBS_WEB.jobs;

/** Open on a completed job, seeded from the row the table already had. */
export const Completed = () => (
  <Stage height={640}>
    <ImportJobDrawer jobId={JOBS[0].jobId} fallback={JOBS[0]} open onClose={() => {}} />
  </Stage>
);

/** Open on a job still processing. */
export const Processing = () => (
  <Stage height={640}>
    <ImportJobDrawer jobId={JOBS[1].jobId} fallback={JOBS[1]} open onClose={() => {}} />
  </Stage>
);

/** Open on a failed job. */
export const Failed = () => (
  <Stage height={640}>
    <ImportJobDrawer jobId={JOBS[2].jobId} fallback={JOBS[2]} open onClose={() => {}} />
  </Stage>
);
