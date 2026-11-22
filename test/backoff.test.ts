import { describe, expect, it } from "vitest";
import { backoffSeconds } from "../src/lib/backoff";

const opts = { baseSeconds: 2, maxSeconds: 60 };

describe("backoffSeconds", () => {
  it("doubles the ceiling with each attempt", () => {
    // random() = 1 gives the top of the range, which is the ceiling itself
    const top = (attempt: number) => backoffSeconds(attempt, { ...opts, random: () => 1 });

    expect(top(1)).toBe(2);
    expect(top(2)).toBe(4);
    expect(top(3)).toBe(8);
    expect(top(4)).toBe(16);
  });

  it("never goes past the cap", () => {
    const top = (attempt: number) => backoffSeconds(attempt, { ...opts, random: () => 1 });

    expect(top(10)).toBe(60);
    expect(top(50)).toBe(60);
    // 2 ** 50 would overflow into nonsense without the cap
    expect(Number.isFinite(top(500))).toBe(true);
    expect(top(500)).toBe(60);
  });

  it("waits at least a second even when the roll is zero", () => {
    expect(backoffSeconds(1, { ...opts, random: () => 0 })).toBe(1);
    expect(backoffSeconds(5, { ...opts, random: () => 0 })).toBe(1);
  });

  it("stays inside the ceiling for any roll", () => {
    for (let attempt = 1; attempt <= 8; attempt++) {
      const ceiling = Math.min(60, 2 * 2 ** (attempt - 1));
      for (let i = 0; i < 50; i++) {
        const delay = backoffSeconds(attempt, opts);
        expect(delay).toBeGreaterThanOrEqual(1);
        expect(delay).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it("actually spreads the retries out", () => {
    // the whole point of jitter: twenty workers failing together must not all
    // come back at the same second
    const delays = new Set(Array.from({ length: 20 }, () => backoffSeconds(5, opts)));
    expect(delays.size).toBeGreaterThan(1);
  });

  it("treats attempt 0 like the first attempt", () => {
    expect(backoffSeconds(0, { ...opts, random: () => 1 })).toBe(2);
  });
});
