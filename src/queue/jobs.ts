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

// Back to pending, to be picked up again once run_at passes. The caller decides
// the delay: a fixed one for now, backoff and Retry-After from step 13.
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
