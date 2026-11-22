import { QueryTypes } from "sequelize";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Courier, CourierError, CreateShipmentInput, Shipment } from "../src/courier/client";
import { sequelize } from "../src/db";
import { enqueue } from "../src/queue/jobs";
import { makeShipmentHandler } from "../src/shipping/createShipment";
import { runOnce } from "../src/worker";

// A courier we can steer, which is the reason the worker depends on the
// interface rather than the concrete client.
function fakeCourier(opts: {
  existing?: Shipment[];
  onCreate?: () => Shipment | never;
}): Courier & { created: CreateShipmentInput[] } {
  const created: CreateShipmentInput[] = [];
  return {
    created,
    async findShipments() {
      return opts.existing ?? [];
    },
    async createShipment(input) {
      created.push(input);
      if (opts.onCreate) return opts.onCreate();
      return { shipmentId: "SHIP-NEW", reference: input.reference };
    },
  };
}

const payload = {
  id: "1001",
  line_items: [{ sku: "A", quantity: 2 }],
  shipping_address: { city: "Pune" },
};

async function givenQueuedOrder(orderId: string) {
  await sequelize.query(
    `INSERT INTO orders (order_id, payload) VALUES ($orderId, $payload::jsonb)`,
    { bind: { orderId, payload: JSON.stringify(payload) }, type: QueryTypes.INSERT }
  );
  await enqueue(orderId);
}

async function order(orderId: string) {
  const [row] = await sequelize.query<{ status: string; shipment_id: string | null }>(
    `SELECT status, shipment_id FROM orders WHERE order_id = $orderId`,
    { bind: { orderId }, type: QueryTypes.SELECT }
  );
  return row;
}

async function job(orderId: string) {
  const [row] = await sequelize.query<{ status: string; attempts: number; last_error: string | null }>(
    `SELECT status, attempts, last_error FROM jobs WHERE order_id = $orderId`,
    { bind: { orderId }, type: QueryTypes.SELECT }
  );
  return row;
}

beforeEach(async () => {
  await sequelize.query("TRUNCATE jobs, orders, webhook_events");
});

afterAll(async () => {
  await sequelize.close();
});

describe("check then create", () => {
  it("creates a shipment when the courier has none", async () => {
    await givenQueuedOrder("1001");
    const courier = fakeCourier({ existing: [] });

    expect(await runOnce(makeShipmentHandler(courier))).toBe("done");

    expect(courier.created).toHaveLength(1);
    expect(courier.created[0]).toEqual({
      reference: "1001",
      address: { city: "Pune" },
      items: [{ sku: "A", quantity: 2 }],
    });
    expect(await order("1001")).toEqual({ status: "shipped", shipment_id: "SHIP-NEW" });
    expect((await job("1001")).status).toBe("done");
  });

  // the case the whole design exists for: a previous attempt created the
  // shipment and timed out before we heard the id
  it("does not create a second shipment when one already exists", async () => {
    await givenQueuedOrder("1001");
    const courier = fakeCourier({
      existing: [{ shipmentId: "SHIP-FROM-TIMEOUT", reference: "1001" }],
    });

    expect(await runOnce(makeShipmentHandler(courier))).toBe("done");

    expect(courier.created).toHaveLength(0);
    expect(await order("1001")).toEqual({
      status: "shipped",
      shipment_id: "SHIP-FROM-TIMEOUT",
    });
  });

  it("keeps the earliest when the courier has several", async () => {
    await givenQueuedOrder("1001");
    const courier = fakeCourier({
      existing: [
        { shipmentId: "SHIP-1", reference: "1001", createdAt: "2026-11-22T10:00:01.000Z" },
        { shipmentId: "SHIP-2", reference: "1001", createdAt: "2026-11-22T10:00:02.000Z" },
      ],
    });

    await runOnce(makeShipmentHandler(courier));

    expect((await order("1001")).shipment_id).toBe("SHIP-1");
    expect(courier.created).toHaveLength(0);
  });

  it("does nothing for an order that is already shipped", async () => {
    await givenQueuedOrder("1001");
    await sequelize.query(
      `UPDATE orders SET status = 'shipped', shipment_id = 'SHIP-OLD' WHERE order_id = '1001'`
    );
    const courier = fakeCourier({ existing: [] });

    expect(await runOnce(makeShipmentHandler(courier))).toBe("done");

    expect(courier.created).toHaveLength(0);
    expect((await order("1001")).shipment_id).toBe("SHIP-OLD");
  });
});

describe("retry decisions", () => {
  it("waits exactly as long as Retry-After says on a 429", async () => {
    await givenQueuedOrder("1001");
    const courier = fakeCourier({
      onCreate: () => {
        throw new CourierError("rate_limited", "slow down", { status: 429, retryAfterSeconds: 2 });
      },
    });

    expect(await runOnce(makeShipmentHandler(courier))).toBe("retrying");

    const [row] = await sequelize.query<{ seconds: number }>(
      `SELECT extract(epoch from (run_at - now())) AS seconds FROM jobs WHERE order_id = '1001'`,
      { type: QueryTypes.SELECT }
    );
    // 2 seconds, allowing for the time the test itself took
    expect(Number(row.seconds)).toBeGreaterThan(0.5);
    expect(Number(row.seconds)).toBeLessThanOrEqual(2);
    expect((await job("1001")).status).toBe("pending");
  });

  it("backs off on a 500 rather than using Retry-After", async () => {
    await givenQueuedOrder("1001");
    const courier = fakeCourier({
      onCreate: () => {
        throw new CourierError("unavailable", "courier exploded", { status: 500 });
      },
    });

    expect(await runOnce(makeShipmentHandler(courier))).toBe("retrying");

    const row = await job("1001");
    expect(row.status).toBe("pending");
    expect(row.last_error).toBe("courier exploded");
    expect(row.attempts).toBe(1);
  });

  it("retries a timeout, because the shipment may exist", async () => {
    await givenQueuedOrder("1001");
    const courier = fakeCourier({
      onCreate: () => {
        throw new CourierError("timeout", "courier did not answer within 5000ms");
      },
    });

    expect(await runOnce(makeShipmentHandler(courier))).toBe("retrying");
    expect((await job("1001")).status).toBe("pending");
    expect((await order("1001")).status).toBe("received");
  });

  it("parks a 4xx straight away and fails the order", async () => {
    await givenQueuedOrder("1001");
    const courier = fakeCourier({
      onCreate: () => {
        throw new CourierError("rejected", "reference is required", { status: 400 });
      },
    });

    expect(await runOnce(makeShipmentHandler(courier))).toBe("dead");

    const row = await job("1001");
    expect(row.status).toBe("dead");
    expect(row.last_error).toBe("reference is required");
    expect((await order("1001")).status).toBe("failed");
  });

  it("recovers on the retry after a timeout, using the shipment the courier kept", async () => {
    await givenQueuedOrder("1001");

    // first attempt: the courier created it but timed out on us
    const timingOut = fakeCourier({
      existing: [],
      onCreate: () => {
        throw new CourierError("timeout", "no answer");
      },
    });
    expect(await runOnce(makeShipmentHandler(timingOut))).toBe("retrying");
    expect((await order("1001")).status).toBe("received");

    await sequelize.query("UPDATE jobs SET run_at = now()");

    // second attempt: the lookup finds what the first attempt actually created
    const findsIt = fakeCourier({
      existing: [{ shipmentId: "SHIP-00001", reference: "1001" }],
    });
    expect(await runOnce(makeShipmentHandler(findsIt))).toBe("done");

    expect(findsIt.created).toHaveLength(0);
    expect(await order("1001")).toEqual({ status: "shipped", shipment_id: "SHIP-00001" });
    expect((await job("1001")).attempts).toBe(2);
  });
});
