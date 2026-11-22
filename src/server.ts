import { config } from "./config";
import { createApp } from "./http/app";

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`api listening on :${config.port}`);
});

// Stop accepting new requests and let in-flight ones finish before exiting.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down api`);
    server.close(() => process.exit(0));
  });
}
