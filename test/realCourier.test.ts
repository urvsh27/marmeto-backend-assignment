import { ChildProcess, spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { QueryTypes } from "sequelize";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCourierClient } from "../src/courier/client";
import { sequelize } from "../src/db";
import { enqueue } from "../src/queue/jobs";
import { makeShipmentHandler } from "../src/shipping/createShipment";
import { runOnce } from "../src/worker";

// The other tests use a stub or a fake courier so they can force one exact
// outcome. This one runs the real mock-courier.js in a child process and talks
// to it through the real client, so the HTTP shape, the timeout and the lookup
// are all exercised together rather than assumed.
//
// Every POST is set to create the shipment and then hang, which is the failure
// the whole design turns on. The retry's lookup should find what the first
// attempt created and never post again.

const root = path.resolve(__dirname, "..");
let courierProcess: ChildProcess;
let port: number;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port: p } = server.address() as net.AddressInfo;
      server.close(() => resolve(p));
    });
  });
}

async function waitForHealth(url: string, timeoutMs = 10000) {
  const giveUpAt = Date.now() + timeoutMs;
  while (Date.now() < giveUpAt) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`mock courier did not come up on ${url}`);
}

beforeAll(async () => {
  port = await freePort();
  courierProcess = spawn("node", ["mock-courier.js"], {
    cwd: root,
    env: {
      ...process.env,
      COURIER_PORT: String(port),
      // every post creates the shipment and then hangs, briefly
      COURIER_FAIL_RATE_500: "0",
      COURIER_FAIL_RATE_429: "0",
      COURIER_FAIL_RATE_TIMEOUT: "1",
      COURIER_HANG_MS: "800",
    },
    stdio: "ignore",
  });
  await waitForHealth(`http://127.0.0.1:${port}`);
}, 20000);

afterAll(async () => {
  courierProcess?.kill();
  await sequelize.close();
});

beforeEach(async () => {
  await sequelize.query("TRUNCATE jobs, orders, webhook_events");
});

async function givenQueuedOrder(orderId: string) {
  await sequelize.query(
    `INSERT INTO orders (order_id, payload) VALUES ($orderId, $payload::jsonb)`,
    {
      bind: {
        orderId,
        payload: JSON.stringify({
          id: orderId,
          line_items: [{ sku: "A", quantity: 1 }],
          shipping_address: { city: "Pune" },
        }),
      },
      type: QueryTypes.INSERT,
    }
  );
  await enqueue(orderId);
}

async function shipmentsAt(reference: string) {
  const res = await fetch(
    `http://127.0.0.1:${port}/shipments?reference=${encodeURIComponent(reference)}`
  );
  const body = (await res.json()) as { shipments: Array<{ shipmentId: string }> };
  return body.shipments;
}

describe("the real client against the real mock courier", () => {
  it("creates one shipment when every post creates then hangs", async () => {
    await givenQueuedOrder("REAL-1");
    // shorter than the mock's 800ms hang, so the client gives up first
    const courier = createCourierClient({
      baseUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 200,
    });
    const handler = makeShipmentHandler(courier);

    // first attempt: the post times out, though the courier did create it
    expect(await runOnce(handler)).toBe("retrying");
    expect(await shipmentsAt("REAL-1")).toHaveLength(1);

    const [order1] = await sequelize.query<{ status: string }>(
      `SELECT status FROM orders WHERE order_id = 'REAL-1'`,
      { type: QueryTypes.SELECT }
    );
    expect(order1.status).toBe("received");

    // second attempt: the lookup finds it, so nothing is posted again
    await sequelize.query("UPDATE jobs SET run_at = now() WHERE status = 'pending'");
    expect(await runOnce(handler)).toBe("done");

    const shipments = await shipmentsAt("REAL-1");
    expect(shipments).toHaveLength(1);

    const [order2] = await sequelize.query<{ status: string; shipment_id: string }>(
      `SELECT status, shipment_id FROM orders WHERE order_id = 'REAL-1'`,
      { type: QueryTypes.SELECT }
    );
    expect(order2.status).toBe("shipped");
    expect(order2.shipment_id).toBe(shipments[0].shipmentId);
  }, 20000);

  it("reports the hang as a timeout, not as a failure to reach the courier", async () => {
    await givenQueuedOrder("REAL-2");
    const courier = createCourierClient({
      baseUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 200,
    });

    await runOnce(makeShipmentHandler(courier));

    const [job] = await sequelize.query<{ last_error: string }>(
      `SELECT last_error FROM jobs WHERE order_id = 'REAL-2'`,
      { type: QueryTypes.SELECT }
    );
    expect(job.last_error).toContain("did not answer within 200ms");
  }, 20000);
});
