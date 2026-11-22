import request from "supertest";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { sequelize } from "../src/db";
import { createApp } from "../src/http/app";

const app = createApp();

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await sequelize.close();
});

describe("GET /health", () => {
  it("is ok while the database answers", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("is 503 when the database does not", async () => {
    vi.spyOn(sequelize, "query").mockRejectedValueOnce(new Error("connection refused"));

    const res = await request(app).get("/health");

    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
  });
});
