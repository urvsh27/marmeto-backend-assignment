import { QueryTypes } from "sequelize";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sequelize } from "../src/db";
import { claim, enqueue } from "../src/queue/jobs";

// a job needs an order to point at, the FK says so
async function givenOrder(orderId: string) {
  await sequelize.query(
    `INSERT INTO orders (order_id, payload) VALUES ($orderId, '{}'::jsonb)`,
    { bind: { orderId }, type: QueryTypes.INSERT }
  );
}

async function jobStatus(orderId: string) {
  const [row] = await sequelize.query<{ status: string; attempts: number; locked_at: Date | null }>(
    `SELECT status, attempts, locked_at FROM jobs WHERE order_id = $orderId`,
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

describe("enqueue", () => {
  it("adds a job and reports that it did", async () => {
    await givenOrder("1001");
    expect(await enqueue("1001")).toBe(true);
  });

  it("reports false and adds nothing the second time", async () => {
    await givenOrder("1001");
    await enqueue("1001");

    expect(await enqueue("1001")).toBe(false);

    const [{ count }] = await sequelize.query<{ count: string }>(
      "SELECT count(*) FROM jobs",
      { type: QueryTypes.SELECT }
    );
    expect(Number(count)).toBe(1);
  });

  it("allows a different job type for the same order", async () => {
    await givenOrder("1001");
    await enqueue("1001");

    expect(await enqueue("1001", { type: "cancel_shipment" })).toBe(true);
  });
});

describe("claim", () => {
  it("returns nothing when the queue is empty", async () => {
    expect(await claim()).toBeNull();
  });

  it("takes a due job, marks it processing and counts the attempt", async () => {
    await givenOrder("1001");
    await enqueue("1001");

    const job = await claim();

    expect(job).toMatchObject({ orderId: "1001", type: "create_shipment", attempts: 1 });
    const row = await jobStatus("1001");
    expect(row.status).toBe("processing");
    expect(row.attempts).toBe(1);
    expect(row.locked_at).not.toBeNull();
  });

  it("leaves a job whose run_at is in the future", async () => {
    await givenOrder("1001");
    await enqueue("1001");
    await sequelize.query("UPDATE jobs SET run_at = now() + interval '1 hour'");

    expect(await claim()).toBeNull();
  });

  it("takes the job that was due first", async () => {
    await givenOrder("1001");
    await givenOrder("1002");
    await enqueue("1001");
    await enqueue("1002");
    await sequelize.query("UPDATE jobs SET run_at = now() - interval '1 minute' WHERE order_id = '1002'");

    const job = await claim();

    expect(job?.orderId).toBe("1002");
  });

  it("does not hand the same job to two workers at once", async () => {
    await givenOrder("1001");
    await enqueue("1001");

    const [a, b] = await Promise.all([claim(), claim()]);

    // one of them gets it, the other steps over the locked row and gets nothing
    const got = [a, b].filter((job) => job !== null);
    expect(got).toHaveLength(1);
    expect(got[0]?.orderId).toBe("1001");
    expect((await jobStatus("1001")).attempts).toBe(1);
  });

  // the test above can pass even without SKIP LOCKED, because the first claim
  // may well have committed before the second query starts. this one can't:
  // the row is locked by a transaction that is still open, so a plain FOR UPDATE
  // would block here until the timeout instead of returning null.
  it("steps over a row another transaction holds locked", async () => {
    await givenOrder("1001");
    await enqueue("1001");

    const holder = await sequelize.transaction();
    await sequelize.query(
      `SELECT id FROM jobs WHERE status = 'pending' ORDER BY run_at LIMIT 1 FOR UPDATE`,
      { transaction: holder, type: QueryTypes.SELECT }
    );

    expect(await claim()).toBeNull();

    await holder.rollback();

    // and it is claimable again once the lock is released
    expect((await claim())?.orderId).toBe("1001");
  });

  it("gives two workers one job each when two are waiting", async () => {
    await givenOrder("1001");
    await givenOrder("1002");
    await enqueue("1001");
    await enqueue("1002");

    const [a, b] = await Promise.all([claim(), claim()]);

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(new Set([a?.orderId, b?.orderId]).size).toBe(2);
  });
});
