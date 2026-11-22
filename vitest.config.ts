import { defineConfig } from "vitest/config";

// Tests run against a real Postgres, on their own database, so the dev data is
// never touched. globalSetup creates it and migrates it.
const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/marmeto_test";

// globalSetup runs in this process, so it needs the value here too
process.env.DATABASE_URL = testDatabaseUrl;

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: testDatabaseUrl,
      // fixed, so the tests don't depend on whatever is in .env
      WEBHOOK_SECRET: "test-secret",
    },
    globalSetup: ["./test/globalSetup.ts"],
    // the db tests share tables and truncate between cases, so no parallel files
    fileParallelism: false,
  },
});
