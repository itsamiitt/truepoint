// withDeadline — race a processor against a per-queue deadline (mirrors TruePoint withDeadline.ts). A
// ProcessorDeadlineError is RETRYABLE (BullMQ re-queues). Orphaned work isn't cancelled — safe because every
// processor is idempotent (keyed writes). The timer is always cleared so it never leaks.
export class ProcessorDeadlineError extends Error {
  constructor(queue: string, ms: number) {
    super(`processor_deadline_exceeded:${queue}:${ms}ms`);
    this.name = "ProcessorDeadlineError";
  }
}

export function withDeadline<J, R>(
  queue: string,
  ms: number,
  processor: (job: J) => Promise<R>,
): (job: J) => Promise<R> {
  return async (job: J): Promise<R> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ProcessorDeadlineError(queue, ms)), ms);
    });
    try {
      return await Promise.race([processor(job), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
