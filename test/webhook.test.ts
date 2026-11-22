import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { QueryTypes } from "sequelize";
import { sequelize } from "../src/db";
import { createApp } from "../src/http/app";
import { sign } from "../src/http/hmac";

const secret = "test-secret";
const app = createApp();
const path = "/webhooks/orders-create";

function order(id: string, city = "Pune") {
  return JSON.stringify({ id, line_items: [{ sku: "A", quantity: 2 }], shipping_address: { city } });
}

// signs whatever body it is given, like the store would
function send(webhookId: string, body: string, signature = sign(body, secret)) {
  return request(app)
    .post(path)
    .set("content-type", "application/json")
    .set("x-shop-hmac-sha256", signature)
    .set("x-shop-webhook-id", webhookId)
    .send(body);
}

async function counts() {
  const [row] = await sequelize.query<{ orders: string; jobs: string; events: string }>(
    `SELECT (SELECT count(*) FROM orders) AS orders,
            (SELECT count(*) FROM jobs) AS jobs,
            (SELECT count(*) FROM webhook_events) AS events`,
    { type: QueryTypes.SELECT }
  );
  return { orders: Number(row.orders), jobs: Number(row.jobs), events: Number(row.events) };
}

beforeEach(async () => {
  await sequelize.query("TRUNCATE jobs, orders, webhook_events");
});

afterAll(async () => {
  await sequelize.close();
});

describe("POST /webhooks/orders-create", () => {
  it("stores the order and queues one job", async () => {
    const res = await send("WH-1", order("1001"));

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ orderId: "1001", duplicate: false });
    expect(await counts()).toEqual({ orders: 1, jobs: 1, events: 1 });

    const [job] = await sequelize.query<{ order_id: string; type: string; status: string; attempts: number }>(
      "SELECT order_id, type, status, attempts FROM jobs",
      { type: QueryTypes.SELECT }
    );
    expect(job).toMatchObject({ order_id: "1001", type: "create_shipment", status: "pending", attempts: 0 });
  });

  it("writes nothing when the signature is wrong", async () => {
    const res = await send("WH-1", order("1001"), sign(order("1001"), "wrong-secret"));

    expect(res.status).toBe(401);
    expect(await counts()).toEqual({ orders: 0, jobs: 0, events: 0 });
  });

  it("rejects a body changed after signing", async () => {
    const body = order("1001");
    const res = await send("WH-1", order("1001", "Mumbai"), sign(body, secret));

    expect(res.status).toBe(401);
    expect(await counts()).toEqual({ orders: 0, jobs: 0, events: 0 });
  });

  it("needs a webhook id", async () => {
    const body = order("1001");
    const res = await request(app)
      .post(path)
      .set("content-type", "application/json")
      .set("x-shop-hmac-sha256", sign(body, secret))
      .send(body);

    expect(res.status).toBe(400);
    expect(await counts()).toEqual({ orders: 0, jobs: 0, events: 0 });
  });

  it("needs an order id in the payload", async () => {
    const body = JSON.stringify({ email: "a@b.com" });
    const res = await send("WH-1", body);

    expect(res.status).toBe(400);
  });

  // the two duplicate cases the spec names
  it("ignores the same webhook id delivered twice", async () => {
    const body = order("1001");
    await send("WH-1", body);
    const res = await send("WH-1", body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ orderId: "1001", duplicate: true });
    expect(await counts()).toEqual({ orders: 1, jobs: 1, events: 1 });
  });

  it("queues no second job for the same order on a new webhook id", async () => {
    const body = order("1001");
    await send("WH-1", body);
    const res = await send("WH-2", body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ orderId: "1001", duplicate: true });
    // the delivery is recorded, the order and job are not duplicated
    expect(await counts()).toEqual({ orders: 1, jobs: 1, events: 2 });
  });

  // a broken store reusing a delivery id must not cost us a real order
  it("still stores the order when a webhook id was used for a different order", async () => {
    await send("WH-1", order("1001"));

    const res = await send("WH-1", order("2002"));

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ orderId: "2002", duplicate: false });
    // both orders exist with a job each, and the reused id is still one event row
    expect(await counts()).toEqual({ orders: 2, jobs: 2, events: 1 });
  });

  it("the order id in the payload may be a json number", async () => {
    // this is what a real store sends. the column is text, so it has to be
    // read as a string on the way in.
    const body = JSON.stringify({ id: 1001, line_items: [], shipping_address: { city: "Pune" } });

    const res = await send("WH-1", body);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ orderId: "1001", duplicate: false });

    const [row] = await sequelize.query<{ order_id: string }>(
      "SELECT order_id FROM orders",
      { type: QueryTypes.SELECT }
    );
    expect(row.order_id).toBe("1001");
  });

  it("treats the same order as a duplicate whether it arrives as a number or a string", async () => {
    await send("WH-1", JSON.stringify({ id: 1001, line_items: [] }));

    const res = await send("WH-2", JSON.stringify({ id: "1001", line_items: [] }));

    expect(res.body).toEqual({ orderId: "1001", duplicate: true });
    expect(await counts()).toEqual({ orders: 1, jobs: 1, events: 2 });
  });

  it("keeps the first payload when a redelivery disagrees", async () => {
    await send("WH-1", order("1001", "Pune"));
    await send("WH-2", order("1001", "Mumbai"));

    const [stored] = await sequelize.query<{ city: string }>(
      `SELECT payload->'shipping_address'->>'city' AS city FROM orders WHERE order_id = '1001'`,
      { type: QueryTypes.SELECT }
    );
    expect(stored.city).toBe("Pune");

    // but the disagreeing delivery is still on record
    const deliveries = await sequelize.query<{ city: string }>(
      `SELECT payload->'shipping_address'->>'city' AS city FROM webhook_events ORDER BY received_at`,
      { type: QueryTypes.SELECT }
    );
    expect(deliveries.map((d) => d.city)).toEqual(["Pune", "Mumbai"]);
  });

  it("creates one order and one job when ten deliveries arrive at once", async () => {
    const body = order("2001");
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => send(`RACE-${i}`, body))
    );

    expect(results.filter((r) => r.status === 202)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(9);
    expect(await counts()).toEqual({ orders: 1, jobs: 1, events: 10 });
  });
});
