import { config } from "./config";
import { sequelize } from "./db";
import { ClaimedJob, claim, complete, retryLater } from "./queue/jobs";

// Fixed for now. Step 13 replaces this with exponential backoff plus jitter,
// and with Retry-After when the courier sends one.
const RETRY_DELAY_SECONDS = 5;

// docker sends SIGKILL ten seconds after SIGTERM, so give up before that
const SHUTDOWN_TIMEOUT_MS = 8000;

export type JobHandler = (job: ClaimedJob) => Promise<void>;

// Placeholder. Step 11 brings the courier client and step 12 the
// check-by-reference that goes in front of it.
const logOnly: JobHandler = async (job) => {
  console.log(`job ${job.id} order ${job.orderId} attempt ${job.attempts}: nothing to do yet`);
};

export type Outcome = "idle" | "done" | "retrying";

// One claim-and-handle cycle, separate from the loop so tests can drive it with
// their own handler and no timers.
export async function runOnce(handler: JobHandler = logOnly): Promise<Outcome> {
  const job = await claim();
  if (!job) return "idle";

  try {
    await handler(job);
    await complete(job.id);
    return "done";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`job ${job.id} order ${job.orderId} failed: ${message}`);
    await retryLater(job.id, RETRY_DELAY_SECONDS, message);
    return "retrying";
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let running = true;

export async function start(handler: JobHandler = logOnly): Promise<void> {
  console.log(`worker started, polling every ${config.workerPollMs}ms`);

  while (running) {
    try {
      const outcome = await runOnce(handler);
      // only wait when there was nothing to do, otherwise drain the queue
      if (outcome === "idle") await sleep(config.workerPollMs);
    } catch (err) {
      // claim itself failed, usually the database being unreachable. keep the
      // loop alive and try again after a pause.
      console.error("worker loop error", err);
      await sleep(config.workerPollMs);
    }
  }

  await sequelize.close();
  console.log("worker stopped");
}

if (require.main === module) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      console.log(`${signal} received, finishing the current job`);
      running = false;

      // same deadline as the api: if the job in hand hangs, don't wait for
      // docker to SIGKILL us
      const deadline = setTimeout(() => {
        console.error("job did not finish in time, exiting anyway");
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);
      deadline.unref();
    });
  }

  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
