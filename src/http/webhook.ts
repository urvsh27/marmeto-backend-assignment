import { Request, Response } from "express";
import { QueryTypes } from "sequelize";
import { config } from "../config";
import { sequelize } from "../db";
import { enqueue } from "../queue/jobs";
import { verify } from "./hmac";

const HMAC_HEADER = "x-shop-hmac-sha256";
const WEBHOOK_ID_HEADER = "x-shop-webhook-id";

// the store sends the order id as a json number. it can be bigger than a JS
// safe integer, which is why we store it as text. reading it as a string when
// the payload offers one keeps the digits intact.
function readOrderId(payload: Record<string, unknown>): string | null {
  const id = payload.id;
  if (typeof id === "string" && id.length > 0) return id;
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  return null;
}

type IntakeResult = { duplicate: boolean };

// One transaction: record the delivery, store the order, queue the courier job.
// All three commit together, so an order can never be stored without a job to
// ship it, and a job can never point at an order that was rolled back.
async function intake(
  webhookId: string,
  orderId: string,
  payload: unknown
): Promise<IntakeResult> {
  const json = JSON.stringify(payload);

  return sequelize.transaction(async (transaction) => {
    // ON CONFLICT DO NOTHING rather than findOrCreate: the unique index decides
    // the winner, so two concurrent deliveries cannot both think they are first.
    const events = await sequelize.query<{ webhook_id: string }>(
      `INSERT INTO webhook_events (webhook_id, order_id, payload)
       VALUES (:webhookId, :orderId, :payload::jsonb)
       ON CONFLICT (webhook_id) DO NOTHING
       RETURNING webhook_id`,
      { replacements: { webhookId, orderId, payload: json }, transaction, type: QueryTypes.SELECT }
    );

    // the exact same delivery again. nothing else to do.
    if (events.length === 0) return { duplicate: true };

    const orders = await sequelize.query<{ order_id: string }>(
      `INSERT INTO orders (order_id, payload)
       VALUES (:orderId, :payload::jsonb)
       ON CONFLICT (order_id) DO NOTHING
       RETURNING order_id`,
      { replacements: { orderId, payload: json }, transaction, type: QueryTypes.SELECT }
    );

    if (orders.length === 0) {
      // a new delivery for an order we already have. the first payload stays,
      // because a shipment may already have been created from it. compared with
      // jsonb equality so key order doesn't matter.
      const [stored] = await sequelize.query<{ same: boolean }>(
        `SELECT payload = :payload::jsonb AS same FROM orders WHERE order_id = :orderId`,
        { replacements: { orderId, payload: json }, transaction, type: QueryTypes.SELECT }
      );
      if (stored && !stored.same) {
        console.warn(
          `order ${orderId} redelivered with a different payload, keeping the stored one`
        );
      }
      return { duplicate: true };
    }

    await enqueue(orderId, { transaction });
    return { duplicate: false };
  });
}

export async function ordersCreate(req: Request, res: Response) {
  // express.raw() puts the untouched bytes here. the signature covers those
  // bytes, so it has to be checked before anything parses or reformats them.
  const rawBody = req.body;
  if (!Buffer.isBuffer(rawBody)) {
    return res.status(400).json({ error: "expected a raw body" });
  }

  if (!verify(rawBody, req.header(HMAC_HEADER), config.webhookSecret)) {
    return res.status(401).json({ error: "invalid signature" });
  }

  const webhookId = req.header(WEBHOOK_ID_HEADER);
  if (!webhookId) {
    return res.status(400).json({ error: `missing ${WEBHOOK_ID_HEADER} header` });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "body is not valid json" });
  }

  const orderId = readOrderId(payload);
  if (!orderId) {
    return res.status(400).json({ error: "payload has no usable order id" });
  }

  try {
    const { duplicate } = await intake(webhookId, orderId, payload);
    // 202 because the courier call hasn't happened yet, it's only queued.
    return res.status(duplicate ? 200 : 202).json({ orderId, duplicate });
  } catch (err) {
    console.error(`intake failed for order ${orderId}`, err);
    // 500 so the store retries the delivery later
    return res.status(500).json({ error: "could not store the order" });
  }
}
