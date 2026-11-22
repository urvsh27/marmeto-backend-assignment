import { QueryTypes } from "sequelize";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config";
import { Courier } from "../src/courier/client";
import { sequelize } from "../src/db";
import { claim, enqueue, requeueStuck } from "../src/queue/jobs";
import { makeShipmentHandler } from "../src/shipping/createShipment";
import { runOnce } from "../src/worker";

const working: Courier = {
  async findShipments() {
    return [];
  },
  async createShipment(input) {
    return { shipmentId: "SHIP-1", reference: input.reference };
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
  const [row] = await sequelize.query<{ status: string; attempts: number; locked_at: Date | null }>(
    `SELECT status, attempts, locked_at FROM jobs WHERE order_id = $orderId`,
    { bind: { orderId }, type: QueryTypes.SELECT }
  );
  return row;
}

// pretend the worker claimed this and then died
async function abandon(orderId: string, secondsAgo: number) {
  await sequelize.query(
    `UPDATE jobs SET locked_at = now() - make_interval(secs => $secondsAgo) WHERE order_id = $orderId`,
    { bind: { orderId, secondsAgo }, type: QueryTypes.UPDATE }
  );
}

beforeEach(async () => {
  await sequelize.query("TRUNCATE jobs, orders, webhook_events");
});

afterAll(async () => {
  await sequelize.close();
});

describe("requeueStuck", () => {
  it("does nothing when no job is processing", async () => {
    await givenQueuedOrder("1001");

    expect(await requeueStuck(60)).toEqual([]);
    expect((await job("1001")).status).toBe("pending");
  });

  it("leaves a job that was only just claimed", async () => {
    await givenQueuedOrder("1001");
    await claim();

    expect(await requeueStuck(60)).toEqual([]);
    expect((await job("1001")).status).toBe("processing");
  });

  it("puts a job abandoned past the timeout back to pending", async () => {
    await givenQueuedOrder("1001");
    await claim();
    await abandon("1001", 120);

    expect(await requeueStuck(60)).toEqual(["1001"]);

    const row = await job("1001");
    expect(row.status).toBe("pending");
    expect(row.locked_at).toBeNull();
  });

  it("keeps the attempt count, so a job that kills workers still dies eventually", async () => {
    await givenQueuedOrder("1001");
    await claim();
    expect((await job("1001")).attempts).toBe(1);

    await abandon("1001", 120);
    await requeueStuck(60);

    expect((await job("1001")).attempts).toBe(1);
  });

  it("makes the job claimable again and it can then finish", async () => {
    await givenQueuedOrder("1001");
    await claim();
    await abandon("1001", 120);
    await requeueStuck(60);

    expect(await runOnce(makeShipmentHandler(working))).toBe("done");
    expect((await job("1001")).status).toBe("done");
    // the lost attempt still counted
    expect((await job("1001")).attempts).toBe(2);
  });

  it("requeues several at once and leaves the fresh one", async () => {
    await givenQueuedOrder("1001");
    await givenQueuedOrder("1002");
    await givenQueuedOrder("1003");
    await claim();
    await claim();
    await claim();
    await abandon("1001", 120);
    await abandon("1002", 120);

    const requeued = await requeueStuck(60);

    expect(requeued.sort()).toEqual(["1001", "1002"]);
    expect((await job("1003")).status).toBe("processing");
  });

  it("recovers a processing job whose lock was never set", async () => {
    // shouldn't happen through claim, but a stranded row that nothing can ever
    // pick up is the worst outcome here, so the query allows for it
    await givenQueuedOrder("1001");
    await claim();
    await sequelize.query(`UPDATE jobs SET locked_at = NULL WHERE order_id = '1001'`);

    expect(await requeueStuck(60)).toEqual(["1001"]);
    expect((await job("1001")).status).toBe("pending");
  });

  it("does not touch done or dead jobs", async () => {
    await givenQueuedOrder("1001");
    await givenQueuedOrder("1002");
    await sequelize.query(
      `UPDATE jobs SET status = 'done', locked_at = now() - interval '1 hour' WHERE order_id = '1001'`
    );
    await sequelize.query(
      `UPDATE jobs SET status = 'dead', locked_at = now() - interval '1 hour' WHERE order_id = '1002'`
    );

    expect(await requeueStuck(60)).toEqual([]);
    expect((await job("1001")).status).toBe("done");
    expect((await job("1002")).status).toBe("dead");
  });

  it("a stuck job that keeps getting abandoned still reaches the attempt limit", async () => {
    await givenQueuedOrder("1001");

    for (let i = 0; i < config.maxAttempts; i++) {
      await claim();
      await abandon("1001", 120);
      await requeueStuck(60);
    }

    expect((await job("1001")).attempts).toBe(config.maxAttempts);
    // the next failure has no attempts left, so it gets parked rather than retried
    const dying: Courier = {
      async findShipments() {
        throw new Error("still broken");
      },
      async createShipment() {
        throw new Error("unreachable");
      },
    };
    expect(await runOnce(makeShipmentHandler(dying))).toBe("dead");
  });
});
