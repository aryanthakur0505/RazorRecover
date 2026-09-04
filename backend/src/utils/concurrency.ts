/** Runs `tasks` with at most `concurrency` in flight at once — a minimal, dependency-free worker
 *  pool. Each task claims the next index as soon as it's free, so faster chains don't wait on
 *  slower ones (no fixed batching), and the results array preserves the tasks' original order.
 *  Shared by the simulation engine (thousands of synthetic chains) and bulk recovery actions
 *  (a merchant approving/rejecting many attempts at once) so neither hammers the DB/Razorpay with
 *  everything at once nor pays the latency cost of running strictly one-at-a-time. */
export async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  const workerCount = Math.max(1, Math.min(concurrency, tasks.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

/** A strict one-at-a-time queue: `run(fn)` waits for every previously-queued `fn` to finish (pass
 *  or fail) before starting. Used to keep the simulation engine's real AI calls from firing in a
 *  burst — up to `SIMULATION_CONCURRENCY` customer chains can independently decide to make an AI
 *  call at nearly the same moment, and Groq's rate limit is per-account, not per-chain, so an
 *  unthrottled burst reliably gets several of them 429'd. Serializing just the network call (not
 *  the surrounding DB work) costs some wall-clock time but is the only thing that actually
 *  prevents a self-inflicted burst, rather than just retrying after the fact. */
export function createMutex() {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const result = tail.then(fn, fn);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
