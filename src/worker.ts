import { config } from "./config";
import { CourierError, createCourierClient } from "./courier/client";
import { sequelize } from "./db";
import { backoffSeconds } from "./lib/backoff";
import { JobHandler, claim, complete, markDead, requeueStuck, retryLater } from "./queue/jobs";
import { makeShipmentHandler, markOrderFailed } from "./shipping/createShipment";

// docker sends SIGKILL ten seconds after SIGTERM, so give up before that
const SHUTDOWN_TIMEOUT_MS = 8000;

export type Outcome = "idle" | "done" | "retrying" | "dead";

const shipWithRealCourier = makeShipmentHandler(createCourierClient());

type Decision = { dead: true; reason: string } | { dead: false; delaySeconds: number };

// Whether to try this job again, and how long to wait.
//   other 4xx  -> our request is wrong, the same request will fail again
//   out of attempts -> park it for a human instead of retrying forever
//   429        -> exactly as long as the courier asked, it knows its own limits
//   5xx, timeout, unreachable -> jittered backoff on the attempt count
function decide(err: unknown, attempts: number): Decision {
  if (err instanceof CourierError && !err.retryable) {
    return { dead: true, reason: `courier rejected the request (${err.status ?? "4xx"})` };
  }

  // attempts is already incremented by claim, so this is the number of tries made
  if (attempts >= config.maxAttempts) {
    return { dead: true, reason: `gave up after ${attempts} attempts` };
  }

  if (err instanceof CourierError && err.kind === "rate_limited" && err.retryAfterSeconds !== undefined) {
    return { dead: false, delaySeconds: Math.max(1, err.retryAfterSeconds) };
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
    const decision = decide(err, job.attempts);

    if (decision.dead) {
      console.error(
        `job ${job.id} order ${job.orderId} parked as dead, ${decision.reason}: ${message}`
      );
      await markDead(job.id, message);
      await markOrderFailed(job.orderId);
      return "dead";
    }

    console.warn(
      `job ${job.id} order ${job.orderId} attempt ${job.attempts} failed, retrying in ${decision.delaySeconds}s: ${message}`
    );
    await retryLater(job.id, decision.delaySeconds, message);
    return "retrying";
  }
}

// Recovers jobs left behind by a worker that died. Exported so it can be tested
// without running the loop.
export async function sweepStuck(): Promise<string[]> {
  const requeued = await requeueStuck(config.jobLockTimeoutSeconds);
  if (requeued.length > 0) {
    console.warn(`requeued ${requeued.length} stuck job(s): ${requeued.join(", ")}`);
  }
  return requeued;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let running = true;

export async function start(handler: JobHandler = shipWithRealCourier): Promise<void> {
  console.log(`worker started, polling every ${config.workerPollMs}ms`);

  // often enough to recover quickly, rarely enough not to be a second poll loop
  const sweepEveryMs = (config.jobLockTimeoutSeconds * 1000) / 2;
  let lastSweep = 0;

  while (running) {
    try {
      if (Date.now() - lastSweep > sweepEveryMs) {
        lastSweep = Date.now();
        await sweepStuck();
      }

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
