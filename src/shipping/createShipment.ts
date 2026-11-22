import { Courier } from "../courier/client";
import { Order, OrderStatus } from "../db/models";
import { JobHandler } from "../queue/jobs";

// Order state lives here. Job state lives in src/queue/jobs.ts. The worker only
// decides which to call.
async function markShipped(orderId: string, shipmentId: string): Promise<void> {
  await Order.update({ status: OrderStatus.shipped, shipmentId }, { where: { orderId } });
}

export async function markOrderFailed(orderId: string): Promise<void> {
  await Order.update({ status: OrderStatus.failed }, { where: { orderId } });
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
    const shipment = await courier.createShipment({
      reference: job.orderId,
      address: payload.shipping_address ?? null,
      items: payload.line_items ?? [],
    });

    console.log(`order ${job.orderId} shipped as ${shipment.shipmentId}`);
    await markShipped(job.orderId, shipment.shipmentId);
  };
}
