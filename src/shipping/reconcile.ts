import { Op } from "sequelize";
import { config } from "../config";
import { Courier } from "../courier/client";
import { Order, OrderStatus } from "../db/models";
import { activeOrderIds, completeFor, reset } from "../queue/jobs";
import { markShipped } from "./createShipment";

export type ReconcileReport = {
  checked: number;
  recorded: string[];
  requeued: string[];
  skippedInFlight: number;
};

// Finds orders that should have shipped by now and haven't, and works out which
// kind of problem each one is.
//
// It never POSTs to the courier. It only asks what exists and either records
// that or puts the job back in the queue for the worker to handle. That keeps
// one place in the codebase that creates shipments, so there is one place that
// can create a duplicate, and it already guards against it.
export async function reconcile(
  courier: Courier,
  olderThanMinutes: number = config.reconcileAfterMinutes
): Promise<ReconcileReport> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);

  const stale = await Order.findAll({
    where: {
      status: { [Op.ne]: OrderStatus.shipped },
      createdAt: { [Op.lt]: cutoff },
    },
    order: [["createdAt", "ASC"]],
  });

  // anything the queue is already dealing with is left alone: the worker's
  // retry path is the normal route and this would only get in its way
  const active = await activeOrderIds();

  const report: ReconcileReport = {
    checked: 0,
    recorded: [],
    requeued: [],
    skippedInFlight: 0,
  };

  for (const order of stale) {
    if (active.has(order.orderId)) {
      report.skippedInFlight += 1;
      continue;
    }

    report.checked += 1;

    const existing = await courier.findShipments(order.orderId);

    if (existing.length > 0) {
      // the courier did create it, we just never recorded it. this is the
      // created-then-timed-out case that outlived its retries.
      const keep = existing[0];
      if (existing.length > 1) {
        console.warn(
          `courier has ${existing.length} shipments for order ${order.orderId}, keeping ${keep.shipmentId}`
        );
      }
      await markShipped(order.orderId, keep.shipmentId);
      await completeFor(order.orderId);
      report.recorded.push(`${order.orderId} -> ${keep.shipmentId}`);
      continue;
    }

    // no shipment anywhere, so this one genuinely needs doing. reset the
    // existing job rather than inserting one, so no duplicate job can appear.
    const requeued = await reset(order.orderId);
    if (requeued) {
      report.requeued.push(order.orderId);
    } else {
      console.warn(`order ${order.orderId} has no job to reset, skipping`);
    }
  }

  return report;
}
