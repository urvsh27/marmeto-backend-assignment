import { QueryTypes } from "sequelize";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Courier, Shipment } from "../src/courier/client";
import { config } from "../src/config";
import { sequelize } from "../src/db";
import { claim, enqueue } from "../src/queue/jobs";
import { reconcile } from "../src/shipping/reconcile";

// Reconcile must never create a shipment. This courier fails the test outright
// if anything asks it to.
function lookupOnlyCourier(shipments: Shipment[] = []): Courier {
  return {
    async findShipments(reference) {
      return shipments.filter((s) => s.reference === reference);
    },
    async createShipment() {
      throw new Error("reconcile must never post to the courier");
    },
  };
}

async function givenOrder(
  orderId: string,
  opts: { minutesOld?: number; status?: string; shipmentId?: string; withJob?: boolean } = {}
) {
  await sequelize.query(
    `INSERT INTO orders (order_id, payload, status, shipment_id, created_at)
     VALUES ($orderId, '{}'::jsonb, $status, $shipmentId,
             now() - make_interval(mins => $minutesOld))`,
    {
      bind: {
        orderId,
        status: opts.status ?? "received",
        shipmentId: opts.shipmentId ?? null,
        minutesOld: opts.minutesOld ?? 60,
      },
      type: QueryTypes.INSERT,
    }
  );
  if (opts.withJob !== false) await enqueue(orderId);
}

async function order(orderId: string) {
  const [row] = await sequelize.query<{ status: string; shipment_id: string | null }>(
    `SELECT status, shipment_id FROM orders WHERE order_id = $orderId`,
    { bind: { orderId }, type: QueryTypes.SELECT }
  );
  return row;
}

async function job(orderId: string) {
  const [row] = await sequelize.query<{ status: string; attempts: number }>(
    `SELECT status, attempts FROM jobs WHERE order_id = $orderId`,
    { bind: { orderId }, type: QueryTypes.SELECT }
  );
  return row;
}

// pretend the worker that claimed this died: the lock is older than the timeout
async function abandonLock(orderId: string) {
  await sequelize.query(
    `UPDATE jobs SET locked_at = now() - make_interval(secs => $secs) WHERE order_id = $orderId`,
    { bind: { orderId, secs: config.jobLockTimeoutSeconds + 60 }, type: QueryTypes.UPDATE }
  );
}

async function park(orderId: string, failureKind: "exhausted" | "rejected" = "exhausted") {
  await sequelize.query(
    `UPDATE jobs SET status = 'dead', attempts = 5, last_error = 'gave up',
            failure_kind = $failureKind
      WHERE order_id = $orderId`,
    { bind: { orderId, failureKind }, type: QueryTypes.UPDATE }
  );
  await sequelize.query(`UPDATE orders SET status = 'failed' WHERE order_id = $orderId`, {
    bind: { orderId },
    type: QueryTypes.UPDATE,
  });
}

beforeEach(async () => {
  await sequelize.query("TRUNCATE jobs, orders, webhook_events");
});

afterAll(async () => {
  await sequelize.close();
});

describe("reconcile", () => {
  it("does nothing when everything is shipped", async () => {
    await givenOrder("1001", { status: "shipped", shipmentId: "SHIP-1" });

    const report = await reconcile(lookupOnlyCourier(), 10);

    expect(report).toEqual({
      checked: 0,
      recorded: [],
      requeued: [],
      skippedInFlight: 0,
      skippedRejected: [],
    });
  });

  it("leaves recent orders alone, the worker has not had its chance yet", async () => {
    await givenOrder("1001", { minutesOld: 1 });
    await park("1001");

    const report = await reconcile(lookupOnlyCourier(), 10);

    expect(report.checked).toBe(0);
    expect((await job("1001")).status).toBe("dead");
  });

  // the case the brief asks for: the courier created it, we timed out, and the
  // retries ran out before we found out
  it("records a shipment the courier had all along", async () => {
    await givenOrder("1001");
    await park("1001");
    const courier = lookupOnlyCourier([{ shipmentId: "SHIP-LOST", reference: "1001" }]);

    const report = await reconcile(courier, 10);

    expect(report.recorded).toEqual(["1001 -> SHIP-LOST"]);
    expect(await order("1001")).toEqual({ status: "shipped", shipment_id: "SHIP-LOST" });
    expect((await job("1001")).status).toBe("done");
  });

  it("keeps the earliest when the courier has more than one", async () => {
    await givenOrder("1001");
    await park("1001");
    const courier = lookupOnlyCourier([
      { shipmentId: "SHIP-1", reference: "1001", createdAt: "2026-11-22T10:00:01.000Z" },
      { shipmentId: "SHIP-2", reference: "1001", createdAt: "2026-11-22T10:00:02.000Z" },
    ]);

    await reconcile(courier, 10);

    expect((await order("1001")).shipment_id).toBe("SHIP-1");
  });

  it("puts the job back when the courier has nothing", async () => {
    await givenOrder("1001");
    await park("1001");

    const report = await reconcile(lookupOnlyCourier(), 10);

    expect(report.requeued).toEqual(["1001"]);
    const row = await job("1001");
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
  });

  it("skips an order whose job is still pending", async () => {
    await givenOrder("1001");

    const report = await reconcile(lookupOnlyCourier(), 10);

    expect(report.skippedInFlight).toBe(1);
    expect(report.checked).toBe(0);
  });

  // reconcile sweeps before it looks at anything. without that, a job a dead
  // worker left in processing looks like work in flight and gets skipped for
  // ever, because nothing else is running to recover it.
  it("recovers a job a dead worker abandoned, so a worker can pick it up again", async () => {
    await givenOrder("1001");
    await claim();
    await abandonLock("1001");

    const report = await reconcile(lookupOnlyCourier(), 10);

    // the sweep put it back, which is why it then counts as in flight
    expect((await job("1001")).status).toBe("pending");
    expect((await job("1001")).attempts).toBe(1);
    expect(report.skippedInFlight).toBe(1);
  });

  it("records the shipment when the abandoned job also had no attempts left", async () => {
    await givenOrder("1001");
    await claim();
    await sequelize.query(`UPDATE jobs SET attempts = $attempts WHERE order_id = '1001'`, {
      bind: { attempts: config.maxAttempts },
      type: QueryTypes.UPDATE,
    });
    await abandonLock("1001");
    const courier = lookupOnlyCourier([{ shipmentId: "SHIP-ORPHAN", reference: "1001" }]);

    const report = await reconcile(courier, 10);

    // the sweep parked it, so reconcile could then look it up and record it
    expect(report.recorded).toEqual(["1001 -> SHIP-ORPHAN"]);
    expect(await order("1001")).toEqual({ status: "shipped", shipment_id: "SHIP-ORPHAN" });
    expect((await job("1001")).status).toBe("done");
  });

  it("skips an order a worker is processing right now", async () => {
    await givenOrder("1001");
    await claim();

    const report = await reconcile(lookupOnlyCourier(), 10);

    expect(report.skippedInFlight).toBe(1);
    expect((await job("1001")).status).toBe("processing");
  });

  it("never asks the courier to create anything", async () => {
    // lookupOnlyCourier throws on createShipment, so this passing is the proof
    await givenOrder("1001");
    await givenOrder("1002");
    await park("1001");
    await park("1002");

    await expect(reconcile(lookupOnlyCourier(), 10)).resolves.toBeTruthy();
  });

  // the courier refused the request, so retrying it just fails the same way.
  // without this, every reconcile run requeued it and the worker killed it again.
  it("leaves a job the courier refused parked, run after run", async () => {
    await givenOrder("1001");
    await park("1001", "rejected");

    for (let pass = 1; pass <= 3; pass++) {
      const report = await reconcile(lookupOnlyCourier(), 10);
      expect(report.requeued).toEqual([]);
      expect(report.skippedRejected).toEqual(["1001"]);
      expect((await job("1001")).status).toBe("dead");
    }
  });

  it("still records a shipment for a refused order if the courier has one", async () => {
    // an earlier attempt may have created it before a later one was refused
    await givenOrder("1001");
    await park("1001", "rejected");
    const courier = lookupOnlyCourier([{ shipmentId: "SHIP-EARLIER", reference: "1001" }]);

    const report = await reconcile(courier, 10);

    expect(report.recorded).toEqual(["1001 -> SHIP-EARLIER"]);
    expect(report.skippedRejected).toEqual([]);
    expect(await order("1001")).toEqual({ status: "shipped", shipment_id: "SHIP-EARLIER" });
  });

  it("still requeues a job that merely ran out of attempts", async () => {
    await givenOrder("1001");
    await park("1001", "exhausted");

    const report = await reconcile(lookupOnlyCourier(), 10);

    expect(report.requeued).toEqual(["1001"]);
    expect(report.skippedRejected).toEqual([]);
  });

  it("is safe to run twice", async () => {
    await givenOrder("1001");
    await park("1001");
    const courier = lookupOnlyCourier([{ shipmentId: "SHIP-LOST", reference: "1001" }]);

    await reconcile(courier, 10);
    const second = await reconcile(courier, 10);

    // first run shipped it, so the second has nothing to look at
    expect(second.checked).toBe(0);
    const [{ count }] = await sequelize.query<{ count: string }>(
      "SELECT count(*) FROM jobs",
      { type: QueryTypes.SELECT }
    );
    expect(Number(count)).toBe(1);
  });

  it("handles a mix in one pass", async () => {
    await givenOrder("recorded-1");
    await park("recorded-1");
    await givenOrder("requeue-1");
    await park("requeue-1");
    await givenOrder("inflight-1");
    await givenOrder("shipped-1", { status: "shipped", shipmentId: "SHIP-OK" });
    await givenOrder("recent-1", { minutesOld: 1 });
    await park("recent-1");

    const courier = lookupOnlyCourier([
      { shipmentId: "SHIP-FOUND", reference: "recorded-1" },
    ]);

    const report = await reconcile(courier, 10);

    expect(report.recorded).toEqual(["recorded-1 -> SHIP-FOUND"]);
    expect(report.requeued).toEqual(["requeue-1"]);
    expect(report.skippedInFlight).toBe(1);
    expect(report.checked).toBe(2);
    expect((await order("recent-1")).status).toBe("failed");
  });
});
