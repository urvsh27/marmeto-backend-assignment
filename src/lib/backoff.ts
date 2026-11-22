import { config } from "../config";

// Exponential backoff with full jitter. The ceiling doubles each attempt up to a
// cap, and the actual wait is a random point below that ceiling.
//
// The jitter is the part that matters. If the courier returns 500 to twenty
// workers at once and they all back off by exactly 4 seconds, they all come
// back at exactly the same moment and knock it over again. Spreading them out
// costs nothing and removes that.
//
// random is injectable so the tests can check the bounds instead of hoping.
export function backoffSeconds(
  attempt: number,
  opts: { baseSeconds?: number; maxSeconds?: number; random?: () => number } = {}
): number {
  const base = opts.baseSeconds ?? config.retryBaseSeconds;
  const max = opts.maxSeconds ?? config.retryMaxSeconds;
  const random = opts.random ?? Math.random;

  const ceiling = Math.min(max, base * 2 ** Math.max(0, attempt - 1));

  // at least a second, so a retry never lands due immediately
  return Math.max(1, Math.round(random() * ceiling));
}
