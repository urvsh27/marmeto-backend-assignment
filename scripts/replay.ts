import { Order } from "../src/db/models";
import { sequelize } from "../src/db";
import { listDead, reset } from "../src/queue/jobs";
import { markOrderForRetry } from "../src/shipping/createShipment";

// npm run replay              list the parked jobs and why they died
// npm run replay <orderId>    put one back in the queue
//
// It resets the existing job row instead of adding one, so replaying twice is
// harmless and can never produce two jobs for the same order.

async function list() {
  const dead = await listDead();

  if (dead.length === 0) {
    console.log("no dead jobs");
    return;
  }

  console.log(`${dead.length} dead job(s):\n`);
  for (const job of dead) {
    console.log(`  ${job.orderId}  ${job.type}  ${job.attempts} attempts  ${job.updatedAt.toISOString()}`);
    console.log(`    ${job.lastError ?? "no error recorded"}`);
  }
  console.log(`\nreplay one with: npm run replay <orderId>`);
}

async function replay(orderId: string) {
  const order = await Order.findByPk(orderId);
  if (!order) {
    console.error(`order ${orderId} is not in the database`);
    process.exitCode = 1;
    return;
  }

  if (order.shipmentId) {
    console.log(`order ${orderId} is already shipped as ${order.shipmentId}, nothing to replay`);
    return;
  }

  const requeued = await reset(orderId);
  if (!requeued) {
    console.error(
      `no job for order ${orderId} that can be replayed. a worker may be processing it right now`
    );
    process.exitCode = 1;
    return;
  }

  await markOrderForRetry(orderId);
  console.log(`order ${orderId} is queued again, the worker will pick it up`);
}

async function main() {
  const orderId = process.argv[2];
  if (orderId) {
    await replay(orderId);
  } else {
    await list();
  }
  await sequelize.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
