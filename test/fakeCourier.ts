import { Courier, CourierError, Shipment } from "../src/courier/client";

export type Outcome = "ok" | "timeout_after_create" | "server_error" | "rate_limited";

// A courier that behaves like mock-courier.js but to a script instead of at
// random, and that keeps its shipments. The important part is
// "timeout_after_create": it really does create the shipment and then fail, so
// the recovery state comes from the courier rather than from the test setting
// it up. A fake that is handed the answer proves much less.
export function fakeCourier(script: (reference: string, call: number) => Outcome) {
  const shipments: Shipment[] = [];
  const createCalls: Record<string, number> = {};
  let counter = 0;

  const courier: Courier = {
    async findShipments(reference) {
      return shipments
        .filter((s) => s.reference === reference)
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    },

    async createShipment(input) {
      const call = (createCalls[input.reference] = (createCalls[input.reference] ?? 0) + 1);
      const outcome = script(input.reference, call);

      if (outcome === "server_error") {
        throw new CourierError("unavailable", "courier exploded", { status: 500 });
      }

      if (outcome === "rate_limited") {
        throw new CourierError("rate_limited", "slow down", {
          status: 429,
          retryAfterSeconds: 1,
        });
      }

      // both remaining outcomes create the shipment
      counter += 1;
      const shipment: Shipment = {
        shipmentId: `SHIP-${String(counter).padStart(5, "0")}`,
        reference: input.reference,
        // ordered, so "the earliest" is well defined
        createdAt: new Date(Date.UTC(2026, 0, 1) + counter * 1000).toISOString(),
      };
      shipments.push(shipment);

      if (outcome === "timeout_after_create") {
        throw new CourierError("timeout", "courier did not answer within 5000ms");
      }

      return shipment;
    },
  };

  return {
    ...courier,
    shipments,
    createCallsFor: (reference: string) => createCalls[reference] ?? 0,
    countFor: (reference: string) => shipments.filter((s) => s.reference === reference).length,
  };
}
