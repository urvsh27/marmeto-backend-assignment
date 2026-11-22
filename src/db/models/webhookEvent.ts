import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
} from "sequelize";
import { sequelize } from "../index";

// every delivery gets a row, including duplicates. keeping the payload means a
// duplicate that disagrees with the stored order is auditable later, not just a
// line in the log.
export class WebhookEvent extends Model<
  InferAttributes<WebhookEvent>,
  InferCreationAttributes<WebhookEvent>
> {
  declare webhookId: string;
  declare orderId: string;
  declare topic: CreationOptional<string>;
  declare payload: Record<string, unknown>;
  declare receivedAt: CreationOptional<Date>;
}

WebhookEvent.init(
  {
    webhookId: { type: DataTypes.TEXT, primaryKey: true },
    orderId: { type: DataTypes.TEXT, allowNull: false },
    topic: { type: DataTypes.TEXT, allowNull: false, defaultValue: "orders/create" },
    payload: { type: DataTypes.JSONB, allowNull: false },
    receivedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "webhook_events", underscored: true, timestamps: false }
);
