import { QueryTypes } from "sequelize";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config";
import { Courier, CourierError } from "../src/courier/client";
import { sequelize } from "../src/db";
import { claim, enqueue, listDead, reset } from "../src/queue/jobs";
import { makeShipmentHandler, markOrderForRetry } from "../src/shipping/createShipment";
import { runOnce } from "../src/worker";

const alwaysBroken: Courier = {
  async findShipments() {
    return [];
  },
  async createShipment() {
    throw new CourierError("unavailable", "courier exploded", { status: 500 });
  },
};

async function givenQueuedOrder(orderId: string) {
  await sequelize.query(
    `INSERT INTO orders (order_id, payload) VALUES ($orderId, '{}'::jsonb)`,
    { bind: { orderId }, type: QueryTypes.INSERT }
  );
  await enqueue(orderId);
}

async function job(orderId: string) {
  const [row] = await sequelize.query<{
    status: string;
    attempts: number;
    last_error: string | null;
    locked_at: Date | null;
  }>(`SELECT status, attempts, last_error, locked_at FROM jobs WHERE order_id = $orderId`, {
    bind: { orderId },
    type: QueryTypes.SELECT,
  });
  return row;
}

async function orderStatus(orderId: string) {
  const [row] = await sequelize.query<{ status: string }>(
    `SELECT status FROM orders WHERE order_id = $orderId`,
    { bind: { orderId }, type: QueryTypes.SELECT }
  );
  return row.status;
}

beforeEach(async () => {
  await sequelize.query("TRUNCATE jobs, orders, webhook_events");
});

afterAll(async () => {
  await sequelize.close();
});

describe("giving up", () => {
  it("keeps retrying while attempts are left", async () => {
    await givenQueuedOrder("1001");
    // one short of the limit, so the next claim takes it to the limit
    await sequelize.query(`UPDATE jobs SET attempts = $attempts`, {
      bind: { attempts: config.maxAttempts - 2 },
      type: QueryTypes.UPDATE,
    });

    expect(await runOnce(makeShipmentHandler(alwaysBroken))).toBe("retrying");
    expect((await job("1001")).status).toBe("pending");
  });

  it("parks the job and fails the order on the last attempt", async () => {
    await givenQueuedOrder("1001");
    await sequelize.query(`UPDATE jobs SET attempts = $attempts`, {
      bind: { attempts: config.maxAttempts - 1 },
      type: QueryTypes.UPDATE,
    });

    expect(await runOnce(makeShipmentHandler(alwaysBroken))).toBe("dead");

    const row = await job("1001");
    expect(row.status).toBe("dead");
    expect(row.attempts).toBe(config.maxAttempts);
    expect(row.last_error).toBe("courier exploded");
    expect(row.locked_at).toBeNull();
    expect(await orderStatus("1001")).toBe("failed");
  });

  it("is not claimed again once it is dead", async () => {
    await givenQueuedOrder("1001");
    await sequelize.query(`UPDATE jobs SET attempts = $attempts`, {
      bind: { attempts: config.maxAttempts - 1 },
      type: QueryTypes.UPDATE,
    });
    await runOnce(makeShipmentHandler(alwaysBroken));

    expect(await runOnce(makeShipmentHandler(alwaysBroken))).toBe("idle");
  });

  it("gets there on its own from a fresh job", async () => {
    await givenQueuedOrder("1001");

    let outcome = "";
    for (let i = 0; i < config.maxAttempts + 2; i++) {
      outcome = await runOnce(makeShipmentHandler(alwaysBroken));
      if (outcome === "dead") break;
      // skip the backoff wait
      await sequelize.query("UPDATE jobs SET run_at = now()");
    }

    expect(outcome).toBe("dead");
    expect((await job("1001")).attempts).toBe(config.maxAttempts);
  });
});

describe("listDead", () => {
  it("returns nothing when there are no dead jobs", async () => {
    expect(await listDead()).toEqual([]);
  });

  it("returns the parked jobs with their error", async () => {
    await givenQueuedOrder("1001");
    await sequelize.query(`UPDATE jobs SET attempts = $attempts`, {
      bind: { attempts: config.maxAttempts - 1 },
      type: QueryTypes.UPDATE,
    });
    await runOnce(makeShipmentHandler(alwaysBroken));

    const dead = await listDead();

    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({
      orderId: "1001",
      type: "create_shipment",
      attempts: config.maxAttempts,
      lastError: "courier exploded",
    });
  });
});

describe("reset", () => {
  it("puts a dead job back as pending with attempts cleared", async () => {
    await givenQueuedOrder("1001");
    await sequelize.query(`UPDATE jobs SET attempts = $attempts`, {
      bind: { attempts: config.maxAttempts - 1 },
      type: QueryTypes.UPDATE,
    });
    await runOnce(makeShipmentHandler(alwaysBroken));

    expect(await reset("1001")).toBe(true);
    await markOrderForRetry("1001");

    const row = await job("1001");
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(await orderStatus("1001")).toBe("received");
  });

  it("makes the job claimable again, and it can then succeed", async () => {
    await givenQueuedOrder("1001");
    await sequelize.query(`UPDATE jobs SET attempts = $attempts`, {
      bind: { attempts: config.maxAttempts - 1 },
      type: QueryTypes.UPDATE,
    });
    await runOnce(makeShipmentHandler(alwaysBroken));
    await reset("1001");
    await markOrderForRetry("1001");

    const working: Courier = {
      async findShipments() {
        return [];
      },
      async createShipment(input) {
        return { shipmentId: "SHIP-AFTER-REPLAY", reference: input.reference };
      },
    };

    expect(await runOnce(makeShipmentHandler(working))).toBe("done");
    expect(await orderStatus("1001")).toBe("shipped");
  });

  it("adds no second job row", async () => {
    await givenQueuedOrder("1001");
    await reset("1001");
    await reset("1001");

    const [{ count }] = await sequelize.query<{ count: string }>(
      "SELECT count(*) FROM jobs",
      { type: QueryTypes.SELECT }
    );
    expect(Number(count)).toBe(1);
  });

  it("reports false for an order with no job", async () => {
    expect(await reset("nope")).toBe(false);
  });

  it("refuses to reset a job a worker is holding", async () => {
    await givenQueuedOrder("1001");
    await claim();

    expect(await reset("1001")).toBe(false);
    expect((await job("1001")).status).toBe("processing");
  });

  it("leaves a shipped order alone", async () => {
    await givenQueuedOrder("1001");
    await sequelize.query(
      `UPDATE orders SET status = 'shipped', shipment_id = 'SHIP-1' WHERE order_id = '1001'`
    );

    await markOrderForRetry("1001");

    expect(await orderStatus("1001")).toBe("shipped");
  });
});
