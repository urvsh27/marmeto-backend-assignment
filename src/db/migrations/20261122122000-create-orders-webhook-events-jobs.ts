import type { Migration } from "../umzug";

// written as SQL rather than queryInterface.createTable: the check constraints
// and the composite unique key read better this way, and what runs is exactly
// what I reviewed.
export const up: Migration["up"] = async ({ context }) => {
  await context.sequelize.query(`
    CREATE TABLE webhook_events (
      webhook_id  text        PRIMARY KEY,
      order_id    text        NOT NULL,
      topic       text        NOT NULL DEFAULT 'orders/create',
      payload     jsonb       NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  // order_id is text because store order ids can be bigger than a JS safe integer.
  // the second check means an order can never be shipped without a shipment id.
  await context.sequelize.query(`
    CREATE TABLE orders (
      order_id    text        PRIMARY KEY,
      payload     jsonb       NOT NULL,
      status      text        NOT NULL DEFAULT 'received'
                              CHECK (status IN ('received', 'shipped', 'failed')),
      shipment_id text        NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),
      CHECK (status <> 'shipped' OR shipment_id IS NOT NULL)
    );
  `);

  // one job row per order and type, so a duplicate job cannot be inserted.
  // replay and reconcile reset this row instead of adding another.
  await context.sequelize.query(`
    CREATE TABLE jobs (
      id         bigserial   PRIMARY KEY,
      order_id   text        NOT NULL REFERENCES orders (order_id),
      type       text        NOT NULL DEFAULT 'create_shipment',
      status     text        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'processing', 'done', 'dead')),
      attempts   integer     NOT NULL DEFAULT 0,
      run_at     timestamptz NOT NULL DEFAULT now(),
      locked_at  timestamptz NULL,
      last_error text        NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (order_id, type)
    );
  `);

  // the worker's claim query filters on status and orders by run_at
  await context.sequelize.query(`
    CREATE INDEX jobs_status_run_at ON jobs (status, run_at);
  `);
};

export const down: Migration["down"] = async ({ context }) => {
  await context.sequelize.query(`DROP TABLE jobs;`);
  await context.sequelize.query(`DROP TABLE orders;`);
  await context.sequelize.query(`DROP TABLE webhook_events;`);
};
