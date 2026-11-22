import { config } from "../config";

export type Shipment = {
  shipmentId: string;
  reference: string;
  createdAt?: string;
};

export type CreateShipmentInput = {
  reference: string;
  address: unknown;
  items: unknown;
};

// The worker depends on this, not on the concrete client, so tests can hand it
// a fake courier instead of running a server.
export interface Courier {
  createShipment(input: CreateShipmentInput): Promise<Shipment>;
  findShipments(reference: string): Promise<Shipment[]>;
}

// What went wrong matters, because each kind gets a different retry decision:
//   rate_limited -> wait exactly as long as the courier asked
//   unavailable  -> 5xx or a connection problem, back off and try again
//   timeout      -> no answer in time, and the shipment may well exist
//   rejected     -> a 4xx we caused, retrying will fail the same way
export type CourierFailure = "rate_limited" | "unavailable" | "timeout" | "rejected";

export class CourierError extends Error {
  readonly kind: CourierFailure;
  readonly status?: number;
  readonly retryAfterSeconds?: number;

  constructor(
    kind: CourierFailure,
    message: string,
    extra: { status?: number; retryAfterSeconds?: number } = {}
  ) {
    super(message);
    this.name = "CourierError";
    this.kind = kind;
    this.status = extra.status;
    this.retryAfterSeconds = extra.retryAfterSeconds;
  }

  get retryable(): boolean {
    return this.kind !== "rejected";
  }
}

// Retry-After is seconds in the spec, but the HTTP header allows a date too.
// Anything we can't read becomes undefined and the caller falls back to backoff.
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;

  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  }

  return undefined;
}

function failureFor(status: number): CourierFailure {
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  return "rejected";
}

export function createCourierClient(
  opts: { baseUrl?: string; timeoutMs?: number } = {}
): Courier {
  const baseUrl = (opts.baseUrl ?? config.courierBaseUrl).replace(/\/$/, "");
  const timeoutMs = opts.timeoutMs ?? config.courierTimeoutMs;

  // Own AbortController rather than AbortSignal.timeout, so a timeout can be
  // told apart from any other abort instead of guessing from the error name.
  async function send(path: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      return await fetch(`${baseUrl}${path}`, { ...init, signal: controller.signal });
    } catch (err) {
      if (timedOut) {
        throw new CourierError("timeout", `courier did not answer within ${timeoutMs}ms`);
      }
      throw new CourierError("unavailable", `could not reach the courier: ${String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async createShipment(input) {
      const res = await send("/shipments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });

      if (!res.ok) {
        throw new CourierError(failureFor(res.status), `create shipment failed with ${res.status}`, {
          status: res.status,
          retryAfterSeconds: parseRetryAfter(res.headers.get("retry-after")),
        });
      }

      const body = (await res.json()) as Partial<Shipment>;
      if (!body.shipmentId) {
        // a 201 with nothing useful in it. not worth retrying blindly.
        throw new CourierError("rejected", "courier returned no shipmentId", { status: res.status });
      }

      return { shipmentId: body.shipmentId, reference: body.reference ?? input.reference };
    },

    async findShipments(reference) {
      const res = await send(`/shipments?reference=${encodeURIComponent(reference)}`);

      if (!res.ok) {
        throw new CourierError(failureFor(res.status), `lookup failed with ${res.status}`, {
          status: res.status,
          retryAfterSeconds: parseRetryAfter(res.headers.get("retry-after")),
        });
      }

      const body = (await res.json()) as { shipments?: Shipment[] };
      // oldest first, so picking "the earliest" is the same answer every time
      return (body.shipments ?? [])
        .slice()
        .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
    },
  };
}
