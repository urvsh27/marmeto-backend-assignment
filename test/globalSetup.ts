import { Client } from "pg";

// Creates the test database if it isn't there, then migrates it. Runs once for
// the whole suite. Migrations rather than sync() so the tests exercise the same
// schema the app gets, check constraints included.
export default async function setup() {
  const url = new URL(process.env.DATABASE_URL as string);
  const database = url.pathname.slice(1);

  // you can't create a database from inside itself, so connect to the default one
  const adminUrl = new URL(url.toString());
  adminUrl.pathname = "/postgres";

  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
  if (existing.rowCount === 0) {
    await admin.query(`CREATE DATABASE "${database}"`);
    console.log(`created test database ${database}`);
  }
  await admin.end();

  const { sequelize } = await import("../src/db");
  const { umzug } = await import("../src/db/umzug");
  await umzug.up();
  await sequelize.close();
}
