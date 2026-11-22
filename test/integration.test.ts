import request from "supertest";
import { QueryTypes } from "sequelize";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sequelize } from "../src/db";
import { createApp } from "../src/http/app";
import { sign } from "../src/http/hmac";
import { JobHandler } from "../src/queue/jobs";
import { makeShipmentHandler } from "../src/shipping/createShipment";
import { Outcome as JobOutcome, runOnce } from "../src/worker";
import { fakeCourier } from "./fakeCourier";

const secret = "test-secret";
const app = createApp();

function body(orderId: string) {
  return JSON.stringify({
    id: orderId,
    line_items: [{ sku: "A", quantity: 1 }],
    shipping_address: { city: "Pune" },
  });
}

function deliver(webhookId: string, orderId: string) {
  const raw = body(orderId);
  return request(app)
    .post("/webhooks/orders-create")
    .set("content-type", "application/json")
    .set("x-shop-hmac-sha256", sign(raw, secret))
    .set("x-shop-webhook-id", webhookId)
    .send(raw);
}

// Runs the worker until the queue is quiet, skipping the backoff waits so the
// test doesn't have to sit through them.
async function drain(handler: JobHandler, maxCycles = 60): Promise<JobOutcome[]> {
  const outcomes: JobOutcome[] = [];
  for (let i = 0; i < maxCycles; i++) {
    const outcome = await runOnce(handler);
    outcomes.push(outcome);
    if (outcome === "idle") break;
    await sequelize.query("UPDATE jobs SET run_at = now() WHERE status = 'pending'");
  }
  return outcomes;
}

async function orders() {
  return sequelize.query<{ order_id: string; status: string; shipment_id: string | null }>(
    `SELECT order_id, status, shipment_id FROM orders ORDER BY order_id`,
    { type: QueryTypes.SELECT }
  );
}

async function jobs() {
  return sequelize.query<{ order_id: string; status: string; attempts: number }>(
    `SELECT order_id, status, attempts FROM jobs ORDER BY order_id`,
    { type: QueryTypes.SELECT }
  );
}

beforeEach(async () => {
  await sequelize.query("TRUNCATE jobs, orders, webhook_events");
});

afterAll(async () => {
  await sequelize.close();
});

describe("webhook through to shipment", () => {
  it("takes a signed webhook and ends with one shipment", async () => {
    const courier = fakeCourier(() => "ok");

    expect((await deliver("WH-1", "1001")).status).toBe(202);
    await drain(makeShipmentHandler(courier));

    expect(await orders()).toEqual([
      { order_id: "1001", status: "shipped", shipment_id: "SHIP-00001" },
    ]);
    expect(courier.countFor("1001")).toBe(1);
  });

  it("creates one shipment when the same webhook arrives twice", async () => {
    const courier = fakeCourier(() => "ok");

    await deliver("WH-1", "1001");
    const duplicate = await deliver("WH-1", "1001");
    expect(duplicate.body).toEqual({ orderId: "1001", duplicate: true });

    await drain(makeShipmentHandler(courier));

    expect(courier.countFor("1001")).toBe(1);
    expect((await jobs())).toHaveLength(1);
  });

  it("creates one shipment when the same order arrives under a new webhook id", async () => {
    const courier = fakeCourier(() => "ok");

    await deliver("WH-1", "1001");
    await deliver("WH-2", "1001");
    await drain(makeShipmentHandler(courier));

    expect(courier.countFor("1001")).toBe(1);
    const [{ count }] = await sequelize.query<{ count: string }>(
      "SELECT count(*) FROM webhook_events",
      { type: QueryTypes.SELECT }
    );
    expect(Number(count)).toBe(2);
  });
});

describe("the courier created it and then timed out", () => {
  it("finds the shipment on the retry instead of creating a second one", async () => {
    // the first create succeeds at the courier and then fails on us
    const courier = fakeCourier((_ref, call) => (call === 1 ? "timeout_after_create" : "ok"));

    await deliver("WH-1", "1001");
    const outcomes = await drain(makeShipmentHandler(courier));

    expect(outcomes[0]).toBe("retrying");
    expect(outcomes).toContain("done");

    // the courier was only ever asked to create once. the second attempt found
    // the shipment the first one had made.
    expect(courier.createCallsFor("1001")).toBe(1);
    expect(courier.countFor("1001")).toBe(1);

    expect(await orders()).toEqual([
      { order_id: "1001", status: "shipped", shipment_id: "SHIP-00001" },
    ]);
  });

  it("would have created two without the lookup, which is the point", async () => {
    // same script, but the handler is given a courier that never reports what it
    // holds. this is what a naive retry looks like.
    const courier = fakeCourier((_ref, call) => (call === 1 ? "timeout_after_create" : "ok"));
    const blindCourier = { ...courier, findShipments: async () => [] };

    await deliver("WH-1", "1001");
    await drain(makeShipmentHandler(blindCourier));

    expect(courier.createCallsFor("1001")).toBe(2);
    expect(courier.countFor("1001")).toBe(2);
  });
});

describe("a batch through an unreliable courier", () => {
  it("ships every order exactly once", async () => {
    // one order per failure mode, and two that work first time
    const script = (reference: string, call: number): ReturnType<typeof scriptFor> =>
      scriptFor(reference, call);

    function scriptFor(reference: string, call: number) {
      if (call > 1) return "ok" as const;
      if (reference === "T-1") return "timeout_after_create" as const;
      if (reference === "T-2") return "timeout_after_create" as const;
      if (reference === "E-1") return "server_error" as const;
      if (reference === "R-1") return "rate_limited" as const;
      return "ok" as const;
    }

    const courier = fakeCourier(script);
    const references = ["T-1", "T-2", "E-1", "R-1", "OK-1", "OK-2"];

    for (const [i, reference] of references.entries()) {
      expect((await deliver(`WH-${i}`, reference)).status).toBe(202);
    }

    await drain(makeShipmentHandler(courier));

    const finalOrders = await orders();
    expect(finalOrders).toHaveLength(6);
    expect(finalOrders.every((o) => o.status === "shipped")).toBe(true);
    expect(finalOrders.every((o) => o.shipment_id !== null)).toBe(true);

    expect((await jobs()).every((j) => j.status === "done")).toBe(true);

    // the headline claim: no reference ended up with two shipments
    for (const reference of references) {
      expect(courier.countFor(reference)).toBe(1);
    }
    expect(courier.shipments).toHaveLength(6);
  });

  it("parks an order the courier always refuses, and leaves the rest alone", async () => {
    const courier = fakeCourier((reference) =>
      reference === "BAD-1" ? "server_error" : "ok"
    );

    await deliver("WH-1", "BAD-1");
    await deliver("WH-2", "GOOD-1");
    await drain(makeShipmentHandler(courier));

    const byId = Object.fromEntries((await orders()).map((o) => [o.order_id, o.status]));
    expect(byId["BAD-1"]).toBe("failed");
    expect(byId["GOOD-1"]).toBe("shipped");

    const jobsById = Object.fromEntries((await jobs()).map((j) => [j.order_id, j]));
    expect(jobsById["BAD-1"].status).toBe("dead");
    expect(jobsById["GOOD-1"].status).toBe("done");
    expect(courier.countFor("GOOD-1")).toBe(1);
  });
});
