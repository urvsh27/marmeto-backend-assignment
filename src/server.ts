import { config } from "./config";
import { sequelize } from "./db";
import { createApp } from "./http/app";

// docker sends SIGKILL ten seconds after SIGTERM, so give up before that and
// exit on our own terms
const SHUTDOWN_TIMEOUT_MS = 8000;

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`api listening on :${config.port}`);
});

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down api`);

  // a client sitting on a keep-alive connection can keep close() waiting
  // forever, so put a deadline on it. unref'd so the timer itself never holds
  // the process open.
  const deadline = setTimeout(() => {
    console.error("shutdown took too long, exiting anyway");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  deadline.unref();

  server.closeIdleConnections();

  server.close(async () => {
    await sequelize.close();
    clearTimeout(deadline);
    console.log("api stopped");
    process.exit(0);
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void shutdown(signal));
}
