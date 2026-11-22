import express, { Express } from "express";
import { ordersCreate } from "./webhook";

// factory so tests can mount the app without starting a listener
export function createApp(): Express {
  const app = express();

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
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
