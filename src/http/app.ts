import express, { Express } from "express";
import { QueryTypes } from "sequelize";
import { sequelize } from "../db";
import { ordersCreate } from "./webhook";

// factory so tests can mount the app without starting a listener
export function createApp(): Express {
  const app = express();

  // hits the database, otherwise this reports healthy while the service can't
  // do anything useful. docker compose depends on this at startup.
  app.get("/health", async (_req, res) => {
    try {
      await sequelize.query("SELECT 1", { type: QueryTypes.SELECT });
      res.json({ ok: true });
    } catch (err) {
      console.error("health check failed", err);
      res.status(503).json({ ok: false, error: "database unreachable" });
    }
  });

  // raw body on this route only, and for any content type, so the bytes the
  // signature was computed over are the bytes we verify. a json body parser
  // here would re-encode them and the hmac would never match.
  app.post(
    "/webhooks/orders-create",
    express.raw({ type: "*/*", limit: "1mb" }),
    ordersCreate
  );

  return app;
}
