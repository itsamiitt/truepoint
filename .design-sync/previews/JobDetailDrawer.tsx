// JobDetailDrawer - one enrichment job in full: its counts, credit spend and timestamps.
import { JobDetailDrawer } from "@leadwolf/ui";
import * as D from "./_webData";
import { Stage } from "./_webPage";

const JOBS = D.W.ENRICHMENT_JOBS_WEB.jobs;

/** A completed job: 4,820 rows in, 3,884 enriched and charged. */
export const Completed = () => (
  <Stage height={640}>
    <JobDetailDrawer job={JOBS[0]} open onClose={() => {}} />
  </Stage>
);

/** A job still running, at 62% with a live count. */
export const Running = () => (
  <Stage height={640}>
    <JobDetailDrawer job={JOBS[1]} open onClose={() => {}} />
  </Stage>
);

/** A failed job, showing the reason rather than an empty panel. */
export const Failed = () => (
  <Stage height={640}>
    <JobDetailDrawer job={JOBS[2]} open onClose={() => {}} />
  </Stage>
);
