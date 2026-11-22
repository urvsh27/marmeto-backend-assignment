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
};

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
      RETURNING id, order_id, type, attempts, run_at, last_error`,
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
  };
}

export async function complete(jobId: string): Promise<void> {
  await sequelize.query(
    `UPDATE jobs
        SET status = 'done', locked_at = NULL, last_error = NULL, updated_at = now()
      WHERE id = $jobId`,
    { bind: { jobId }, type: QueryTypes.UPDATE }
  );
}

// A worker that is killed mid-job leaves the row in processing with nobody
// working on it, and nothing would ever claim it again. Anything locked for
// longer than a job could plausibly take goes back to pending.
//
// attempts is deliberately not reset: a job that kills the worker every time
// would otherwise loop forever instead of eventually reaching dead.
//
// The timeout has to be longer than the slowest real job, or this will requeue
// work that is still running and two workers will do it at once. Harmless here
// because of the check-by-reference, but still wrong.
export async function requeueStuck(olderThanSeconds: number): Promise<string[]> {
  const rows = await sequelize.query<{ order_id: string }>(
    `UPDATE jobs
        SET status = 'pending', locked_at = NULL, updated_at = now()
      WHERE status = 'processing'
        AND (locked_at IS NULL
             OR locked_at < now() - make_interval(secs => $olderThanSeconds))
      RETURNING order_id`,
    { bind: { olderThanSeconds }, type: QueryTypes.SELECT }
  );

  return rows.map((row) => row.order_id);
}

export type DeadJob = {
  id: string;
  orderId: string;
  type: string;
  attempts: number;
  lastError: string | null;
  updatedAt: Date;
};

// "Somewhere visible" from the brief. Dead jobs are rows you can query, not log
// lines, which is what makes them findable and replayable later.
export async function listDead(limit = 50): Promise<DeadJob[]> {
  const rows = await sequelize.query<Omit<JobRow, "run_at"> & { updated_at: Date }>(
    `SELECT id, order_id, type, attempts, last_error, updated_at
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
export async function markDead(jobId: string, lastError: string): Promise<void> {
  await sequelize.query(
    `UPDATE jobs
        SET status = 'dead', locked_at = NULL, last_error = $lastError, updated_at = now()
      WHERE id = $jobId`,
    { bind: { jobId, lastError }, type: QueryTypes.UPDATE }
  );
}

// Back to pending, to be picked up again once run_at passes. The caller decides
// the delay: Retry-After when the courier sent one, otherwise jittered backoff.
export async function retryLater(
  jobId: string,
  delaySeconds: number,
  lastError: string
): Promise<void> {
  await sequelize.query(
    `UPDATE jobs
        SET status = 'pending',
            locked_at = NULL,
            run_at = now() + make_interval(secs => $delaySeconds),
            last_error = $lastError,
            updated_at = now()
      WHERE id = $jobId`,
    { bind: { jobId, delaySeconds, lastError }, type: QueryTypes.UPDATE }
  );
}
