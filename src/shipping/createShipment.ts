import { Op } from "sequelize";
import { config } from "../config";
import { Courier, CourierError, Shipment } from "../courier/client";
import { Order, OrderStatus } from "../db/models";
import { ClaimedJob, JobHandler } from "../queue/jobs";

// Order state lives here. Job state lives in src/queue/jobs.ts. The worker only
// decides which to call.
export async function markShipped(orderId: string, shipmentId: string): Promise<void> {
  await Order.update({ status: OrderStatus.shipped, shipmentId }, { where: { orderId } });
}

// Never touches a shipped order. A worker can ship an order and then be killed
// before it marks the job done, and the sweep would otherwise park that job and
// overwrite a real shipment with "failed".
export async function markOrderFailed(orderId: string): Promise<void> {
  await Order.update(
    { status: OrderStatus.failed },
    { where: { orderId, status: { [Op.ne]: OrderStatus.shipped } } }
  );
}

// Back to the starting state so a replayed job is handled normally. Only touches
// failed orders: a shipped one is finished and must not be reopened.
export async function markOrderForRetry(orderId: string): Promise<void> {
  await Order.update(
    { status: OrderStatus.received },
    { where: { orderId, status: OrderStatus.failed } }
  );
}

// Only on the final attempt, and only when the failure could have left a
// shipment behind. A 4xx means the courier never accepted the request, so there
// is nothing to find; a timeout or a 5xx means there might well be.
async function lastChanceLookup(
  courier: Courier,
  job: ClaimedJob,
  err: unknown
): Promise<boolean> {
  const isLastAttempt = job.attempts >= config.maxAttempts;
  const couldHaveLanded =
    err instanceof CourierError && (err.kind === "timeout" || err.kind === "unavailable");

  if (!isLastAttempt || !couldHaveLanded) return false;

  const found = await courier.findShipments(job.orderId);
  if (found.length === 0) return false;

  console.warn(
    `order ${job.orderId} failed on its last attempt but the courier had ${found[0].shipmentId}, recording it`
  );
  await markShipped(job.orderId, found[0].shipmentId);
  return true;
}

// The courier is not idempotent and it sometimes creates a shipment and then
// hangs, so the id never reaches us. Every attempt therefore asks what already
// exists for this reference before it creates anything. Without that, a retry
// after a timeout produces a second parcel for the same order.
export function makeShipmentHandler(courier: Courier): JobHandler {
  return async (job) => {
    const order = await Order.findByPk(job.orderId);
    if (!order) {
      throw new Error(`order ${job.orderId} is not in the database`);
    }

    if (order.status === OrderStatus.shipped && order.shipmentId) {
      console.log(`order ${job.orderId} is already shipped as ${order.shipmentId}`);
      return;
    }

    const existing = await courier.findShipments(job.orderId);
    if (existing.length > 0) {
      // the client sorts oldest first, so "the first one" is the same answer
      // here and in the reconcile job
      const keep = existing[0];
      if (existing.length > 1) {
        console.warn(
          `courier has ${existing.length} shipments for order ${job.orderId}, keeping ${keep.shipmentId}`
        );
      }
      console.log(`order ${job.orderId} already had shipment ${keep.shipmentId} at the courier`);
      await markShipped(job.orderId, keep.shipmentId);
      return;
    }

    const payload = order.payload as Record<string, unknown>;

    let shipment: Shipment;
    try {
      shipment = await courier.createShipment({
        reference: job.orderId,
        address: payload.shipping_address ?? null,
        items: payload.line_items ?? [],
      });
    } catch (err) {
      // On the last attempt, look once more before letting this job die. A
      // timeout is exactly the case where the shipment probably does exist, and
      // without this the order sits as failed until reconcile runs minutes later.
      const salvaged = await lastChanceLookup(courier, job, err);
      if (salvaged) return;
      throw err;
    }

    console.log(`order ${job.orderId} shipped as ${shipment.shipmentId}`);
    await markShipped(job.orderId, shipment.shipmentId);
  };
}
