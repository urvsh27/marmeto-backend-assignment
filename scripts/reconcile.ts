import { config } from "../src/config";
import { createCourierClient } from "../src/courier/client";
import { sequelize } from "../src/db";
import { reconcile } from "../src/shipping/reconcile";

// npm run reconcile          orders older than RECONCILE_AFTER_MINUTES
// npm run reconcile 1        orders older than 1 minute, handy for testing
//
// Safe to run repeatedly and safe to run while workers are going: it skips
// anything the queue is still dealing with, and it never creates a shipment
// itself.

async function main() {
  const minutes = process.argv[2] ? Number(process.argv[2]) : config.reconcileAfterMinutes;
  if (!Number.isFinite(minutes) || minutes < 0) {
    console.error(`not a number of minutes: ${process.argv[2]}`);
    process.exit(1);
  }

  console.log(`looking for unshipped orders older than ${minutes} minute(s)`);

  const report = await reconcile(createCourierClient(), minutes);

  console.log(`checked ${report.checked}, skipped ${report.skippedInFlight} still in flight`);

  if (report.recorded.length > 0) {
    console.log(`\nthe courier already had these, recorded them:`);
    for (const line of report.recorded) console.log(`  ${line}`);
  }

  if (report.requeued.length > 0) {
    console.log(`\nno shipment at the courier, put back in the queue:`);
    for (const orderId of report.requeued) console.log(`  ${orderId}`);
  }

  if (report.recorded.length === 0 && report.requeued.length === 0) {
    console.log("nothing to do");
  }

  await sequelize.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
