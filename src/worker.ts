import { config } from "./config";
import { CourierError, createCourierClient } from "./courier/client";
import { sequelize } from "./db";
import { backoffSeconds } from "./lib/backoff";
import {
  ClaimedJob,
  FailureKind,
  JobHandler,
  SweepResult,
  claim,
  complete,
  markDead,
  retryLater,
} from "./queue/jobs";
import { makeShipmentHandler, markOrderFailed } from "./shipping/createShipment";
import { recoverStuckJobs } from "./shipping/recoverStuck";

// docker sends SIGKILL ten seconds after SIGTERM, so give up before that
const SHUTDOWN_TIMEOUT_MS = 8000;

export type Outcome = "idle" | "done" | "retrying" | "dead";

const shipWithRealCourier = makeShipmentHandler(createCourierClient());

type Decision =
  | { dead: true; kind: FailureKind; reason: string }
  | { dead: false; delaySeconds: number };

// Whether to try this job again, and how long to wait.
//   other 4xx  -> our request is wrong, the same request will fail again
//   out of attempts -> park it for a human instead of retrying forever
//   429        -> exactly as long as the courier asked, it knows its own limits
//   5xx, timeout, unreachable -> jittered backoff on the attempt count
//
// A 429 counts as an attempt like anything else, so a courier that is merely
// busy can still use up a job's attempts. That is deliberate: a job cannot sit
// in the queue indefinitely, and reconcile will pick it up afterwards. A
// separate, larger allowance for rate limiting would be the better answer at
// higher volume.
function decide(err: unknown, attempts: number): Decision {
  if (err instanceof CourierError && !err.retryable) {
    return {
      dead: true,
      kind: "rejected",
      reason: `courier rejected the request (${err.status ?? "4xx"})`,
    };
  }

  // attempts is already incremented by claim, so this is the number of tries made
  if (attempts >= config.maxAttempts) {
    return { dead: true, kind: "exhausted", reason: `gave up after ${attempts} attempts` };
  }

  if (err instanceof CourierError && err.kind === "rate_limited" && err.retryAfterSeconds !== undefined) {
    return { dead: false, delaySeconds: Math.max(1, err.retryAfterSeconds) };
  }

  // anything that isn't a CourierError is a bug on our side, but retrying is
  // still safer than dropping the job. the retry is sequential, so the lookup at
  // the start of the next attempt will find anything the failed one created.
  return { dead: false, delaySeconds: backoffSeconds(attempts) };
}

// The job was requeued under us while we were working on it, which means this
// worker stalled for longer than the lock timeout. Another worker owns it now,
// so say so loudly and change nothing.
function lostIt(job: ClaimedJob) {
  console.warn(
    `job ${job.id} order ${job.orderId} was taken over by another worker while we were on it, leaving it alone`
  );
}

// One claim-and-handle cycle, separate from the loop so tests can drive it with
// their own handler and no timers.
export async function runOnce(handler: JobHandler = shipWithRealCourier): Promise<Outcome> {
  const job = await claim();
  if (!job) return "idle";

  try {
    await handler(job);
    const kept = await complete(job.id, job.lockedAt);
    if (!kept) lostIt(job);
    return "done";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const decision = decide(err, job.attempts);

    if (decision.dead) {
      console.error(
        `job ${job.id} order ${job.orderId} parked as dead, ${decision.reason}: ${message}`
      );
      const kept = await markDead(job.id, job.lockedAt, message, decision.kind);
      if (!kept) {
        lostIt(job);
        return "dead";
      }
      await markOrderFailed(job.orderId);
      return "dead";
    }

    console.warn(
      `job ${job.id} order ${job.orderId} attempt ${job.attempts} failed, retrying in ${decision.delaySeconds}s: ${message}`
    );
    const kept = await retryLater(job.id, job.lockedAt, decision.delaySeconds, message);
    if (!kept) lostIt(job);
    return "retrying";
  }
}

// Kept as a name the worker and its tests use. The work itself lives in
// src/shipping/recoverStuck.ts because the reconcile script needs it too.
export async function sweepStuck(): Promise<SweepResult> {
  return recoverStuckJobs();
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
