import { QueryTypes } from "sequelize";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sequelize } from "../src/db";
import { enqueue } from "../src/queue/jobs";
import { runOnce } from "../src/worker";

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
    locked_at: Date | null;
    last_error: string | null;
    run_at: Date;
  }>(
    `SELECT status, attempts, locked_at, last_error, run_at FROM jobs WHERE order_id = $orderId`,
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

describe("runOnce", () => {
  it("does nothing when the queue is empty", async () => {
    expect(await runOnce(async () => {})).toBe("idle");
  });

  it("hands the claimed job to the handler and marks it done", async () => {
    await givenQueuedOrder("1001");
    const seen: string[] = [];

    const outcome = await runOnce(async (j) => {
      seen.push(j.orderId);
    });

    expect(outcome).toBe("done");
    expect(seen).toEqual(["1001"]);
    const row = await job("1001");
    expect(row.status).toBe("done");
    expect(row.locked_at).toBeNull();
    expect(row.last_error).toBeNull();
  });

  it("puts the job back and records the error when the handler throws", async () => {
    await givenQueuedOrder("1001");

    const outcome = await runOnce(async () => {
      throw new Error("courier exploded");
    });

    expect(outcome).toBe("retrying");
    const row = await job("1001");
    expect(row.status).toBe("pending");
    expect(row.last_error).toBe("courier exploded");
    expect(row.attempts).toBe(1);
    expect(row.locked_at).toBeNull();
    // and it isn't due immediately, so the worker doesn't spin on it
    expect(row.run_at.getTime()).toBeGreaterThan(Date.now());
  });

  it("counts a second attempt when the retried job comes back round", async () => {
    await givenQueuedOrder("1001");
    await runOnce(async () => {
      throw new Error("first failure");
    });
    // pretend the delay has passed
    await sequelize.query("UPDATE jobs SET run_at = now()");

    const outcome = await runOnce(async () => {});

    expect(outcome).toBe("done");
    expect((await job("1001")).attempts).toBe(2);
  });

  it("takes one job per call, not the whole queue", async () => {
    await givenQueuedOrder("1001");
    await givenQueuedOrder("1002");

    const handled: string[] = [];
    const handler = async (j: { orderId: string }) => {
      handled.push(j.orderId);
    };

    expect(await runOnce(handler)).toBe("done");
    expect(handled).toHaveLength(1);
    expect(await runOnce(handler)).toBe("done");
    expect(handled).toHaveLength(2);
    expect(await runOnce(handler)).toBe("idle");
  });
});
