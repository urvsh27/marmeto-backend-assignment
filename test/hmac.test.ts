import { describe, expect, it } from "vitest";
import { sign, verify } from "../src/http/hmac";

const secret = "test-secret";
const body = Buffer.from('{"id":1001,"city":"Pune"}');

describe("hmac", () => {
  it("accepts a signature made over the same bytes", () => {
    expect(verify(body, sign(body, secret), secret)).toBe(true);
  });

  it("rejects a body that changed after signing", () => {
    const signature = sign(body, secret);
    expect(verify(Buffer.from('{"id":9999}'), signature, secret)).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    expect(verify(body, sign(body, "other-secret"), secret)).toBe(false);
  });

  it("rejects a missing header instead of throwing", () => {
    expect(verify(body, undefined, secret)).toBe(false);
  });

  // timingSafeEqual throws on a length mismatch, so this is the case that turns
  // a junk header into a 500 if the length check is ever removed
  it("rejects a header of the wrong length instead of throwing", () => {
    expect(() => verify(body, "nope", secret)).not.toThrow();
    expect(verify(body, "nope", secret)).toBe(false);
  });

  it("treats whitespace as part of the body", () => {
    const compact = Buffer.from('{"id":1001}');
    const spaced = Buffer.from('{ "id" : 1001 }');
    expect(verify(spaced, sign(compact, secret), secret)).toBe(false);
  });
});
