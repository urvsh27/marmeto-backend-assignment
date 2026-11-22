import { config } from "./config";
import { CourierError, createCourierClient } from "./courier/client";
import { sequelize } from "./db";
import { backoffSeconds } from "./lib/backoff";
import { JobHandler, claim, complete, markDead, retryLater } from "./queue/jobs";
import { makeShipmentHandler, markOrderFailed } from "./shipping/createShipment";

// docker sends SIGKILL ten seconds after SIGTERM, so give up before that
const SHUTDOWN_TIMEOUT_MS = 8000;

export type Outcome = "idle" | "done" | "retrying" | "dead";

const shipWithRealCourier = makeShipmentHandler(createCourierClient());

// How long to wait before trying this job again, and whether to bother.
//   429        -> exactly as long as the courier asked, it knows its own limits
//   5xx, timeout, unreachable -> jittered backoff on the attempt count
//   other 4xx  -> our request is wrong, the same request will fail again
function decide(err: unknown, attempts: number): { dead: boolean; delaySeconds: number } {
  if (err instanceof CourierError) {
    if (!err.retryable) return { dead: true, delaySeconds: 0 };
    if (err.kind === "rate_limited" && err.retryAfterSeconds !== undefined) {
      return { dead: false, delaySeconds: Math.max(1, err.retryAfterSeconds) };
    }
  }

  // anything that isn't a CourierError is a bug on our side, but retrying is
  // still safer than dropping the job: check-by-reference makes it harmless
  return { dead: false, delaySeconds: backoffSeconds(attempts) };
}

// One claim-and-handle cycle, separate from the loop so tests can drive it with
// their own handler and no timers.
export async function runOnce(handler: JobHandler = shipWithRealCourier): Promise<Outcome> {
  const job = await claim();
  if (!job) return "idle";

  try {
    await handler(job);
    await complete(job.id);
    return "done";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const { dead, delaySeconds } = decide(err, job.attempts);

    if (dead) {
      console.error(`job ${job.id} order ${job.orderId} parked as dead: ${message}`);
      await markDead(job.id, message);
      await markOrderFailed(job.orderId);
      return "dead";
    }

    console.warn(
      `job ${job.id} order ${job.orderId} attempt ${job.attempts} failed, retrying in ${delaySeconds}s: ${message}`
    );
    await retryLater(job.id, delaySeconds, message);
    return "retrying";
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let running = true;

export async function start(handler: JobHandler = shipWithRealCourier): Promise<void> {
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
