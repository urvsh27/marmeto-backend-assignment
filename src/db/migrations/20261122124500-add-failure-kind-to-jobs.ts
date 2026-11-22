import type { Migration } from "../umzug";

// Why a job died, so the difference between "the courier refused this request"
// and "we ran out of attempts" survives in the row.
//
// Reconcile needs it: retrying a job the courier rejected just fails the same
// way and it would requeue it on every run. Replay ignores it, because an
// operator asking for a retry has presumably fixed something.
export const up: Migration["up"] = async ({ context }) => {
  await context.sequelize.query(`
    ALTER TABLE jobs
      ADD COLUMN failure_kind text NULL
        CHECK (failure_kind IS NULL OR failure_kind IN ('rejected', 'exhausted'));
  `);
};

export const down: Migration["down"] = async ({ context }) => {
  await context.sequelize.query(`ALTER TABLE jobs DROP COLUMN failure_kind;`);
};
