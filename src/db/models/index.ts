// importing from here registers all three models on the sequelize instance
export { Order, OrderStatus } from "./order";
export { WebhookEvent } from "./webhookEvent";
export { Job, JobStatus } from "./job";

import { Order } from "./order";
import { Job } from "./job";

// jobs.order_id is a real FK in the migration. telling sequelize about it too
// keeps includes working if I ever need to join them.
Job.belongsTo(Order, { foreignKey: "orderId", targetKey: "orderId" });
Order.hasOne(Job, { foreignKey: "orderId", sourceKey: "orderId" });
