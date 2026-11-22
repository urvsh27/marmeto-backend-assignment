import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
} from "sequelize";
import { sequelize } from "../index";

export type JobStatus = "pending" | "processing" | "done" | "dead";

export class Job extends Model<InferAttributes<Job>, InferCreationAttributes<Job>> {
  // bigserial comes back as a string from pg, which is fine, we only log it
  declare id: CreationOptional<string>;
  declare orderId: string;
  declare type: CreationOptional<string>;
  declare status: CreationOptional<JobStatus>;
  declare attempts: CreationOptional<number>;
  declare runAt: CreationOptional<Date>;
  declare lockedAt: CreationOptional<Date | null>;
  declare lastError: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

Job.init(
  {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    orderId: { type: DataTypes.TEXT, allowNull: false },
    type: { type: DataTypes.TEXT, allowNull: false, defaultValue: "create_shipment" },
    status: { type: DataTypes.TEXT, allowNull: false, defaultValue: "pending" },
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    runAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    lockedAt: { type: DataTypes.DATE, allowNull: true },
    lastError: { type: DataTypes.TEXT, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "jobs", underscored: true }
);
