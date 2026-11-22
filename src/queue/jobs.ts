import { QueryTypes, Transaction } from "sequelize";
import { sequelize } from "../db";

export const CREATE_SHIPMENT = "create_shipment";

export type ClaimedJob = {
  id: string;
  orderId: string;
  type: string;
  attempts: number;
  runAt: Date;
  lastError: string | null;
  // proof of ownership, passed back when finishing the job
  lockedAt: Date;
};

// Only the worker still holding a job may change it. A worker that stalls long
// enough for the sweep to requeue its job, while another worker picks it up and
// finishes it, must not then be able to overwrite that result.
//
// date_trunc is not decoration: Postgres stores timestamptz to the microsecond
// and the pg driver hands it back as a JS Date, which only has milliseconds. A
// plain `locked_at = $lockedAt` matches nothing at all.
const STILL_OURS = `status = 'processing'
                    AND date_trunc('milliseconds', locked_at) = $lockedAt`;

// lives here rather than in the worker so src/shipping can refer to it without
// importing the worker back
export type JobHandler = (job: ClaimedJob) => Promise<void>;

type JobRow = {
  id: string;
  order_id: string;
  type: string;
  attempts: number;
  run_at: Date;
  last_error: string | null;
  locked_at: Date;
};

// Every read and write of the jobs table lives in this file. Swapping the
// Postgres queue for BullMQ or SQS later should mean rewriting this one module
// and nothing else.

// Returns false when a job for this order and type already exists. The unique
// key does the deciding, not a prior SELECT, so two webhooks arriving at the
// same moment cannot both win.
export async function enqueue(
  orderId: string,
  opts: { type?: string; transaction?: Transaction } = {}
): Promise<boolean> {
  const rows = await sequelize.query<{ id: string }>(
    `INSERT INTO jobs (order_id, type)
     VALUES ($orderId, $type)
     ON CONFLICT (order_id, type) DO NOTHING
     RETURNING id`,
    {
      bind: { orderId, type: opts.type ?? CREATE_SHIPMENT },
      transaction: opts.transaction,
      type: QueryTypes.SELECT,
    }
  );

  return rows.length > 0;
}

// Takes one due job and marks it processing, in a single statement.
//
// FOR UPDATE SKIP LOCKED is what makes several workers safe: a worker locks the
// row it picked, and any other worker running the same query steps over that
// row instead of waiting behind it. Without SKIP LOCKED the second worker would
// block on the lock and then claim the same job once the first committed.
//
// attempts is incremented here rather than on failure. If a worker is killed
// mid-job the attempt still counts, so requeueStuck can't put a job that
// crashes the process back into pending forever without it ever reaching dead.
//
// updated_at is set by hand because this bypasses Sequelize, which would
// normally maintain it.
export async function claim(): Promise<ClaimedJob | null> {
  const rows = await sequelize.query<JobRow>(
    `UPDATE jobs
        SET status = 'processing',
            locked_at = now(),
            attempts = attempts + 1,
            updated_at = now()
      WHERE id = (
            SELECT id
              FROM jobs
             WHERE status = 'pending'
               AND run_at <= now()
             ORDER BY run_at
             LIMIT 1
             FOR UPDATE SKIP LOCKED
      )
      RETURNING id, order_id, type, attempts, run_at, last_error, locked_at`,
    { type: QueryTypes.SELECT }
  );

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    orderId: row.order_id,
    type: row.type,
    attempts: row.attempts,
    runAt: row.run_at,
    lastError: row.last_error,
    lockedAt: row.locked_at,
  };
}

// Returns false when the job was taken away from us, so the caller can say so
// rather than assuming it worked.
export async function complete(jobId: string, lockedAt: Date): Promise<boolean> {
  const rows = await sequelize.query<{ id: string }>(
    `UPDATE jobs
        SET status = 'done', locked_at = NULL, last_error = NULL, updated_at = now()
      WHERE id = $jobId AND ${STILL_OURS}
      RETURNING id`,
    { bind: { jobId, lockedAt }, type: QueryTypes.SELECT }
  );
  return rows.length > 0;
}

export type SweepResult = {
  requeued: string[];
  // ran out of attempts while nobody was holding them, so they are parked rather
  // than put back
  parked: string[];
};

// A worker that is killed mid-job leaves the row in processing with nobody
// working on it, and nothing would ever claim it again. Anything locked for
// longer than a job could plausibly take is picked up here.
//
// attempts is not reset, and jobs that have none left are marked dead instead of
// requeued. Both halves are needed: a job that kills the worker every time never
// reaches the handler's error path, so if this only requeued it, it would cycle
// processing -> pending forever and never be parked.
//
// The lock timeout has to be longer than the slowest real job. If it isn't, a
// job that is still running gets requeued and a second worker picks it up while
// the first is mid-call. Check-by-reference does NOT save you there: both
// workers can look, both see nothing, and both create. What keeps one worker per
// job is SKIP LOCKED plus this timeout being comfortably above the slowest job.
export async function requeueStuck(
  olderThanSeconds: number,
  maxAttempts: number
): Promise<SweepResult> {
  const stuck = `status = 'processing'
                 AND (locked_at IS NULL
                      OR locked_at < now() - make_interval(secs => $olderThanSeconds))`;

  const parked = await sequelize.query<{ order_id: string }>(
    `UPDATE jobs
        SET status = 'dead',
            locked_at = NULL,
            failure_kind = 'exhausted',
            last_error = coalesce(last_error, 'worker stopped before finishing'),
            updated_at = now()
      WHERE ${stuck} AND attempts >= $maxAttempts
      RETURNING order_id`,
    { bind: { olderThanSeconds, maxAttempts }, type: QueryTypes.SELECT }
  );

  const requeued = await sequelize.query<{ order_id: string }>(
    `UPDATE jobs
        SET status = 'pending', locked_at = NULL, updated_at = now()
      WHERE ${stuck} AND attempts < $maxAttempts
      RETURNING order_id`,
    { bind: { olderThanSeconds, maxAttempts }, type: QueryTypes.SELECT }
  );

  return {
    requeued: requeued.map((row) => row.order_id),
    parked: parked.map((row) => row.order_id),
  };
}

// Orders whose job was parked because the courier refused the request. Retrying
// those fails the same way, so reconcile leaves them for a human.
export async function rejectedOrderIds(): Promise<Set<string>> {
  const rows = await sequelize.query<{ order_id: string }>(
    `SELECT order_id FROM jobs WHERE status = 'dead' AND failure_kind = 'rejected'`,
    { type: QueryTypes.SELECT }
  );

  return new Set(rows.map((row) => row.order_id));
}

// Orders that something is already working on, or is about to. Reconcile uses
// this to leave them alone rather than interfering with the normal retry path.
// It is here, not in the reconcile script, because which job states count as
// "in flight" is the queue's business and would change with the queue.
export async function activeOrderIds(): Promise<Set<string>> {
  const rows = await sequelize.query<{ order_id: string }>(
    `SELECT DISTINCT order_id FROM jobs WHERE status IN ('pending', 'processing')`,
    { type: QueryTypes.SELECT }
  );

  return new Set(rows.map((row) => row.order_id));
}

// Marks the job for an order done without needing its id, which reconcile
// doesn't have.
export async function completeFor(
  orderId: string,
  type: string = CREATE_SHIPMENT
): Promise<boolean> {
  const rows = await sequelize.query<{ id: string }>(
    `UPDATE jobs
        SET status = 'done', locked_at = NULL, last_error = NULL, updated_at = now()
      WHERE order_id = $orderId AND type = $type AND status <> 'processing'
      RETURNING id`,
    { bind: { orderId, type }, type: QueryTypes.SELECT }
  );

  return rows.length > 0;
}

export type DeadJob = {
  id: string;
  orderId: string;
  type: string;
  attempts: number;
  lastError: string | null;
  failureKind: FailureKind | null;
  updatedAt: Date;
};

// "Somewhere visible" from the brief. Dead jobs are rows you can query, not log
// lines, which is what makes them findable and replayable later.
export async function listDead(limit = 50): Promise<DeadJob[]> {
  const rows = await sequelize.query<
    Omit<JobRow, "run_at"> & { updated_at: Date; failure_kind: FailureKind | null }
  >(
    `SELECT id, order_id, type, attempts, last_error, failure_kind, updated_at
       FROM jobs
      WHERE status = 'dead'
      ORDER BY updated_at DESC
      LIMIT $limit`,
    { bind: { limit }, type: QueryTypes.SELECT }
  );

  return rows.map((row) => ({
    id: row.id,
    orderId: row.order_id,
    type: row.type,
    attempts: row.attempts,
    lastError: row.last_error,
    failureKind: row.failure_kind,
    updatedAt: row.updated_at,
  }));
}

// Puts an existing job back in the queue. Used by the replay script and by
// reconcile. It never inserts, so the one-job-per-order-and-type rule holds no
// matter how many times either runs.
//
// A job that is currently processing is left alone: a worker is holding it, and
// resetting it underneath would have two workers on the same order. A worker
// that died leaves it processing too, but requeueStuck is what recovers those.
export async function reset(orderId: string, type: string = CREATE_SHIPMENT): Promise<boolean> {
  const rows = await sequelize.query<{ id: string }>(
    `UPDATE jobs
        SET status = 'pending',
            attempts = 0,
            run_at = now(),
            locked_at = NULL,
            failure_kind = NULL,
            updated_at = now()
      WHERE order_id = $orderId
        AND type = $type
        AND status <> 'processing'
      RETURNING id`,
    { bind: { orderId, type }, type: QueryTypes.SELECT }
  );

  return rows.length > 0;
}

// Parked. Nothing claims it again until something sets it back to pending, which
// is what scripts/replay.ts and the reconcile job do. The error stays on the row
// so you can see why from a query.
export type FailureKind = "rejected" | "exhausted";

export async function markDead(
  jobId: string,
  lockedAt: Date,
  lastError: string,
  failureKind: FailureKind
): Promise<boolean> {
  const rows = await sequelize.query<{ id: string }>(
    `UPDATE jobs
        SET status = 'dead',
            locked_at = NULL,
            last_error = $lastError,
            failure_kind = $failureKind,
            updated_at = now()
      WHERE id = $jobId AND ${STILL_OURS}
      RETURNING id`,
    { bind: { jobId, lockedAt, lastError, failureKind }, type: QueryTypes.SELECT }
  );
  return rows.length > 0;
}

// Back to pending, to be picked up again once run_at passes. The caller decides
// the delay: Retry-After when the courier sent one, otherwise jittered backoff.
export async function retryLater(
  jobId: string,
  lockedAt: Date,
  delaySeconds: number,
  lastError: string
): Promise<boolean> {
  const rows = await sequelize.query<{ id: string }>(
    `UPDATE jobs
        SET status = 'pending',
            locked_at = NULL,
            run_at = now() + make_interval(secs => $delaySeconds),
            last_error = $lastError,
            updated_at = now()
      WHERE id = $jobId AND ${STILL_OURS}
      RETURNING id`,
    { bind: { jobId, lockedAt, delaySeconds, lastError }, type: QueryTypes.SELECT }
  );
  return rows.length > 0;
}
