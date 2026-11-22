import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
} from "sequelize";
import { sequelize } from "../index";

export type OrderStatus = "received" | "shipped" | "failed";

export class Order extends Model<InferAttributes<Order>, InferCreationAttributes<Order>> {
  declare orderId: string;
  declare payload: Record<string, unknown>;
  declare status: CreationOptional<OrderStatus>;
  declare shipmentId: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

Order.init(
  {
    orderId: { type: DataTypes.TEXT, primaryKey: true },
    payload: { type: DataTypes.JSONB, allowNull: false },
    status: { type: DataTypes.TEXT, allowNull: false, defaultValue: "received" },
    shipmentId: { type: DataTypes.TEXT, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "orders", underscored: true }
);
