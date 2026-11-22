import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CourierError, createCourierClient } from "../src/courier/client";

// A stub courier instead of mock-courier.js: these tests need one exact
// outcome per request, not a random one.
type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

let server: http.Server;
let baseUrl: string;
let handler: Handler;

beforeAll(async () => {
  server = http.createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  handler = (_req, res) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
}

const client = () => createCourierClient({ baseUrl, timeoutMs: 300 });

const input = { reference: "ORD-1", address: { city: "Pune" }, items: [{ sku: "A" }] };

// asserts the call rejected, and narrows the type so the expects below typecheck
async function failure(call: Promise<unknown>): Promise<CourierError> {
  try {
    await call;
  } catch (err) {
    if (err instanceof CourierError) return err;
    throw err;
  }
  throw new Error("expected the courier call to fail, it succeeded");
}

describe("createShipment", () => {
  it("returns the shipment on 201", async () => {
    respond(201, { shipmentId: "SHIP-00001", reference: "ORD-1" });

    await expect(client().createShipment(input)).resolves.toEqual({
      shipmentId: "SHIP-00001",
      reference: "ORD-1",
    });
  });

  it("reads Retry-After on a 429", async () => {
    respond(429, { error: "slow down" }, { "retry-after": "2" });

    const err = await failure(client().createShipment(input));

    expect(err.kind).toBe("rate_limited");
    expect(err.retryAfterSeconds).toBe(2);
    expect(err.retryable).toBe(true);
  });

  it("leaves retryAfterSeconds unset when the header is missing", async () => {
    respond(429, { error: "slow down" });

    const err = await failure(client().createShipment(input));

    expect(err.kind).toBe("rate_limited");
    expect(err.retryAfterSeconds).toBeUndefined();
  });

  it("reads Retry-After given as a date", async () => {
    respond(429, {}, { "retry-after": new Date(Date.now() + 5000).toUTCString() });

    const err = await failure(client().createShipment(input));

    expect(err.retryAfterSeconds).toBeGreaterThan(2);
    expect(err.retryAfterSeconds).toBeLessThanOrEqual(6);
  });

  it("treats a 500 as unavailable and retryable", async () => {
    respond(500, { error: "courier exploded" });

    const err = await failure(client().createShipment(input));

    expect(err.kind).toBe("unavailable");
    expect(err.status).toBe(500);
    expect(err.retryable).toBe(true);
  });

  it("treats a 400 as rejected and not retryable", async () => {
    respond(400, { error: "reference is required" });

    const err = await failure(client().createShipment(input));

    expect(err.kind).toBe("rejected");
    expect(err.retryable).toBe(false);
  });

  it("times out instead of waiting for a hanging courier", async () => {
    // never responds, like the mock's 10s hang
    handler = () => {};

    const started = Date.now();
    const err = await failure(client().createShipment(input));

    expect(err.kind).toBe("timeout");
    expect(err.retryable).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("rejects a success with no shipmentId", async () => {
    respond(201, { reference: "ORD-1" });

    const err = await failure(client().createShipment(input));

    expect(err.kind).toBe("rejected");
  });

  it("reports an unreachable courier as unavailable", async () => {
    // nothing is listening on this port
    const offline = createCourierClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 300 });

    const err = await failure(offline.createShipment(input));

    expect(err.kind).toBe("unavailable");
    expect(err.retryable).toBe(true);
  });
});

describe("findShipments", () => {
  it("returns an empty list when the courier has none", async () => {
    respond(200, { shipments: [] });

    await expect(client().findShipments("ORD-1")).resolves.toEqual([]);
  });

  it("returns shipments oldest first whatever order they arrive in", async () => {
    respond(200, {
      shipments: [
        { shipmentId: "SHIP-2", reference: "ORD-1", createdAt: "2026-11-22T10:00:02.000Z" },
        { shipmentId: "SHIP-1", reference: "ORD-1", createdAt: "2026-11-22T10:00:01.000Z" },
      ],
    });

    const found = await client().findShipments("ORD-1");

    expect(found.map((s) => s.shipmentId)).toEqual(["SHIP-1", "SHIP-2"]);
  });

  it("escapes the reference in the query string", async () => {
    let seenUrl = "";
    handler = (req, res) => {
      seenUrl = req.url ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ shipments: [] }));
    };

    await client().findShipments("ORD 1&x=2");

    expect(seenUrl).toBe("/shipments?reference=ORD%201%26x%3D2");
  });

  it("surfaces a 500 from the lookup as unavailable", async () => {
    respond(500, { error: "nope" });

    const err = await failure(client().findShipments("ORD-1"));

    expect(err.kind).toBe("unavailable");
  });
});
