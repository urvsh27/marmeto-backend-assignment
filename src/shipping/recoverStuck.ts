import { config } from "../config";
import { SweepResult, requeueStuck } from "../queue/jobs";
import { markOrderFailed } from "./createShipment";

// Recovers jobs left in processing by a worker that died: anything locked longer
// than the lock timeout goes back to pending, unless it has no attempts left, in
// which case it is parked.
//
// Both the worker loop and the reconcile script call this. The worker is the
// usual route, but if every worker is down nothing sweeps, and then an abandoned
// job looks "in flight" to reconcile for ever. Running it from reconcile too
// means there is always something that can recover those.
export async function recoverStuckJobs(): Promise<SweepResult> {
  const result = await requeueStuck(config.jobLockTimeoutSeconds, config.maxAttempts);

  if (result.requeued.length > 0) {
    console.warn(`requeued ${result.requeued.length} stuck job(s): ${result.requeued.join(", ")}`);
  }

  for (const orderId of result.parked) {
    await markOrderFailed(orderId);
  }
  if (result.parked.length > 0) {
    console.error(
      `parked ${result.parked.length} stuck job(s) with no attempts left: ${result.parked.join(", ")}`
    );
  }

  return result;
}
