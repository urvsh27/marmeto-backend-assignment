import crypto from "node:crypto";

// base64 hmac-sha256 over the exact bytes we were sent. the send-webhook script
// and the tests sign with this too, so there is one definition of a signature.
export function sign(rawBody: Buffer | string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
}

export function verify(
  rawBody: Buffer,
  headerValue: string | undefined,
  secret: string
): boolean {
  if (!headerValue) return false;

  const expected = Buffer.from(sign(rawBody, secret), "utf8");
  const received = Buffer.from(headerValue, "utf8");

  // timingSafeEqual throws on a length mismatch, so that has to be checked
  // first. the length of a signature isn't a secret, so returning early is fine.
  if (expected.length !== received.length) return false;

  return crypto.timingSafeEqual(expected, received);
}
