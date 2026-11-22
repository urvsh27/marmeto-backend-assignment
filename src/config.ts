import "dotenv/config";

// read env once at boot. better to crash here than halfway through a webhook.
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}. Copy .env.example to .env.`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? "development",
  databaseUrl: required("DATABASE_URL"),
  dbLogging: process.env.DB_LOGGING === "true",
  webhookSecret: required("WEBHOOK_SECRET"),
  courierBaseUrl: process.env.COURIER_BASE_URL ?? "http://localhost:4000",
};
