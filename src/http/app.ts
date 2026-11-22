import express, { Express } from "express";

// factory so tests can mount the app without starting a listener
export function createApp(): Express {
  const app = express();

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  return app;
}
