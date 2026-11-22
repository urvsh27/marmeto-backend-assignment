// stands in for the courier partner. run with: node mock-courier.js
// fails on purpose, rates are env vars so tests can turn them off.
require("dotenv/config");

const express = require("express");

const port = Number(process.env.COURIER_PORT || 4000);
const rate500 = Number(process.env.COURIER_FAIL_RATE_500 ?? 0.2);
const rate429 = Number(process.env.COURIER_FAIL_RATE_429 ?? 0.1);
const rateHang = Number(process.env.COURIER_FAIL_RATE_TIMEOUT ?? 0.1);
const hangMs = Number(process.env.COURIER_HANG_MS ?? 10000);
const retryAfter = Number(process.env.COURIER_RETRY_AFTER ?? 2);

// in-memory, restart for a clean courier
const shipments = [];
let counter = 0;

// no check on reference, so posting twice really does create two shipments
function createShipment(body) {
  counter += 1;
  const shipment = {
    shipmentId: `SHIP-${String(counter).padStart(5, "0")}`,
    reference: body.reference,
    address: body.address ?? null,
    items: body.items ?? [],
    createdAt: new Date().toISOString(),
  };
  shipments.push(shipment);
  return shipment;
}

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true, shipments: shipments.length }));

app.post("/shipments", (req, res) => {
  const { reference } = req.body || {};
  if (!reference) {
    return res.status(400).json({ error: "reference is required" });
  }

  // one roll, so the rates add up instead of compounding
  const roll = Math.random();

  if (roll < rate500) {
    console.log(`POST /shipments ${reference} -> 500`);
    return res.status(500).json({ error: "courier exploded" });
  }

  if (roll < rate500 + rate429) {
    console.log(`POST /shipments ${reference} -> 429`);
    return res.status(429).set("Retry-After", String(retryAfter)).json({ error: "slow down" });
  }

  if (roll < rate500 + rate429 + rateHang) {
    // create it, then go quiet. caller times out but the shipment is real.
    const shipment = createShipment(req.body);
    console.log(`POST /shipments ${reference} -> created ${shipment.shipmentId}, hanging ${hangMs}ms`);
    return setTimeout(() => {
      res.status(201).json({ shipmentId: shipment.shipmentId, reference: shipment.reference });
    }, hangMs);
  }

  const shipment = createShipment(req.body);
  console.log(`POST /shipments ${reference} -> 201 ${shipment.shipmentId}`);
  res.status(201).json({ shipmentId: shipment.shipmentId, reference: shipment.reference });
});

app.get("/shipments", (req, res) => {
  const { reference } = req.query;
  const found = reference ? shipments.filter((s) => s.reference === reference) : shipments;
  res.json({ shipments: found });
});

app.listen(port, () => {
  console.log(
    `mock courier on :${port} (500=${rate500} 429=${rate429} hang=${rateHang} hangMs=${hangMs})`
  );
});
