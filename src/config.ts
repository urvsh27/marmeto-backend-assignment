import "dotenv/config";

// read env once at boot. better to crash here than halfway through a webhook.
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}. Copy .env.example to .env.`);
  }
  return value;
}

const port = Number(process.env.PORT ?? 3000);

export const config = {
  port,
  // only used by the scripts, so they can point at a container or another host
  apiBaseUrl: process.env.API_BASE_URL ?? `http://localhost:${port}`,
  nodeEnv: process.env.NODE_ENV ?? "development",
  databaseUrl: required("DATABASE_URL"),
  dbLogging: process.env.DB_LOGGING === "true",
  webhookSecret: required("WEBHOOK_SECRET"),
  courierBaseUrl: process.env.COURIER_BASE_URL ?? "http://localhost:4000",
  // the mock hangs for 10s on ~10% of calls, so this has to give up well before
  courierTimeoutMs: Number(process.env.COURIER_TIMEOUT_MS ?? 5000),
  workerPollMs: Number(process.env.WORKER_POLL_MS ?? 1000),
  maxAttempts: Number(process.env.MAX_ATTEMPTS ?? 5),
  // must be longer than the slowest job, or a job still running gets requeued
  jobLockTimeoutSeconds: Number(process.env.JOB_LOCK_TIMEOUT_SECONDS ?? 60),
  // how long an order can sit unshipped before reconcile looks at it. long
  // enough that the normal retry path has had its chance first.
  reconcileAfterMinutes: Number(process.env.RECONCILE_AFTER_MINUTES ?? 10),
  retryBaseSeconds: Number(process.env.RETRY_BASE_SECONDS ?? 2),
  retryMaxSeconds: Number(process.env.RETRY_MAX_SECONDS ?? 60),
};
