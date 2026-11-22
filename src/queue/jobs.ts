import { QueryTypes, Transaction } from "sequelize";
import { sequelize } from "../db";

export const CREATE_SHIPMENT = "create_shipment";

// Every read and write of the jobs table lives in this file. Swapping the
// Postgres queue for BullMQ or SQS later should mean rewriting this one module
// and nothing else.

// Returns false when a job for this order and type already exists. The unique
// key does the deciding, not a prior SELECT, so two webhooks arriving at the
// same moment cannot both win.
export async function enqueue(
  orderId: string,
  opts: { type?: string; transaction?: Transaction } = {}
): Promise<boolean> {
  const rows = await sequelize.query<{ id: string }>(
    `INSERT INTO jobs (order_id, type)
     VALUES (:orderId, :type)
     ON CONFLICT (order_id, type) DO NOTHING
     RETURNING id`,
    {
      replacements: { orderId, type: opts.type ?? CREATE_SHIPMENT },
      transaction: opts.transaction,
      type: QueryTypes.SELECT,
    }
  );

  return rows.length > 0;
}
