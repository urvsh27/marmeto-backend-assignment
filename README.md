# marmeto-backend-assignment

Takes `orders/create` webhooks and creates a shipment with a courier.

The courier is unreliable (rate limits, 5xx, and sometimes it creates the
shipment then hangs until you give up) and the store can deliver the same
webhook twice. So the endpoint just stores the order and returns, and a worker
does the courier call with retries.

Node 20, TypeScript, Express, Postgres, Sequelize. Migrations with Umzug. The
queue is a table. API and worker are separate processes.

## Run it

```bash
docker compose up
```

Postgres, a one-shot migrate, the mock courier on 4000, the API on 3000, the
worker. API and worker wait for the migration so they can't start on an empty
schema.

Without Docker you need a Postgres somewhere. Compose can give you just that:

```bash
docker compose up -d postgres
npm install
cp .env.example .env
npm run migrate
npm run dev
```

`npm run dev` runs the API, worker and mock together. To run one on its own
there's `npm run dev:api`, `npm run dev:worker` and `npm run mock`. Settings and
defaults are in `.env.example`.

## Try it

```bash
npm run send-webhook
```

```
new order                        202  {"orderId":"ORD-...","duplicate":false}
same webhook id again            200  {"orderId":"ORD-...","duplicate":true}
new webhook id, same order       200  {"orderId":"ORD-...","duplicate":true}
tampered body                    401  {"error":"invalid signature"}
```

Both duplicate cases plus a bad signature. Exits non-zero if any of them is
wrong. 202 and not 200 on a new order because the courier hasn't been called
yet, it's only queued.

## Tests

```bash
npm test
```

120 tests, Vitest and Supertest against a real Postgres on its own database,
created and migrated on first run. They go at the parts most likely to break:
HMAC, the duplicate paths (asserting row counts, including ten concurrent
deliveries of one order), each courier failure mode against a stub server,
claiming under concurrency, giving up, and webhook-to-shipment end to end. One
runs the real client against the real `mock-courier.js` with every POST set to
create-then-hang.

I checked they actually catch things by deleting each safeguard in turn and
confirming the right tests fail. `npm run typecheck` covers src, scripts and
tests.

## Design notes

**Queue is a Postgres table, not BullMQ.** The order row and its job row go in
one transaction. With Redis that's a dual write: commit the order, push the job,
crash in between, shipment lost. Jobs being rows also makes replay and reconcile
plain SQL, and there's no extra infra to run.

It costs something: a job waits up to `WORKER_POLL_MS` instead of being pushed,
every worker runs a claim query on every tick (fine at tens/sec, constant write
traffic on one hot table at thousands), and I had to write the backoff myself,
which is code that can be wrong. Hence the tests.

All `jobs` access goes through `src/queue/jobs.ts`. Swapping to BullMQ or SQS
should be that one file. The idempotency isn't in there, it's in unique keys, so
it survives the swap.

**`ON CONFLICT DO NOTHING`, not `findOrCreate`.** One statement, unique index
decides. `findOrCreate` reads then writes, so two simultaneous deliveries can
both read "nothing there" and both write. `ignoreDuplicates` emits the right SQL
but won't tell you whether it inserted, which is the bit I need to decide whether
to queue a job. Same reason for the other raw SQL: `ON CONFLICT`,
`FOR UPDATE SKIP LOCKED` and jsonb equality aren't things the ORM models. Models
do the ordinary reads and writes.

**Worker asks before it creates.** Every attempt does
`GET /shipments?reference=` first and only POSTs if nothing comes back, because
the courier isn't idempotent and ~10% of its calls create the shipment and then
hang. If the last attempt fails on a timeout or 5xx it looks once more before
dying, since those are the ones that might have landed. A 4xx gets no extra
lookup, nothing was accepted.

In one 500-order run the mock logged 65 hangs, every one of which created a real
shipment I never got an id for. All 65 were found by the lookup. Without it that
run ends with 565 shipments for 500 orders.

**One worker per job**, from three things: `SKIP LOCKED` on the claim, a lock
timeout well above the slowest job, and an ownership check (`status` still
`processing` and the same `locked_at`) on every write a worker makes to its job,
so one that stalled past the timeout and lost the job can't clobber it.

Worth being clear: the lookup only protects *sequential* retries. Concurrency is
protected by that one-worker-per-job guarantee. Two workers on the same order
could both look, both see nothing, both create.

**Retries.**

| got back | do |
| --- | --- |
| 429 with `Retry-After` | wait that long, min 1s |
| 429 without it | jittered backoff |
| 5xx, timeout, unreachable | exponential backoff, full jitter, capped |
| any other 4xx | don't retry, `dead` |

Out of attempts is checked first, so a failure on the last try is parked rather
than delayed. Jitter because twenty workers that got a 500 together shouldn't
come back together.

A 429 burns an attempt like anything else, so a merely busy courier can park a
job that has nothing wrong with it. The alternative lets a job sit in the queue
indefinitely with nothing surfacing it, so I took the bounded version. Proper
fix is a rate limiter shared across workers.

**One job row per `(order_id, type)`**, unique key. A duplicate job can't exist.
Replay and reconcile reset that row instead of inserting, so neither can fan out
and running either twice does nothing. Cost: a replay loses the previous error,
one row holds it.

## Schema

Three tables, one migration, plus a second adding `jobs.failure_kind`.

- `webhook_events`, keyed on `X-Shop-Webhook-Id`. One row per distinct delivery
  id, with the payload it arrived with. A redelivery under the same id doesn't
  add a row; a new id for an order we already have does.
- `orders`, keyed on the store's order id as **text** (store ids can be bigger
  than a JS safe integer). Payload jsonb, status `received`/`shipped`/`failed`,
  shipment id once there is one.
- `jobs`. Index on `(status, run_at)` for the claim.

Two checks on `orders`: status limited to those three values, and an order can't
be `shipped` without a `shipment_id`. The second one only rules out that one bad
row, it doesn't stop two parcels at the courier. That's the lookup's job.

Duplicate handling, since it's the point of the exercise:

- same webhook id, same order: event insert does nothing, stop. Normal
  redelivery.
- same order, new webhook id: delivery recorded, order not overwritten, no new
  job.
- same webhook id, *different* order: warn, then store and queue it anyway. A
  store reusing delivery ids is broken, but dropping a real order over it is
  worse.

If a redelivery disagrees with the stored payload the first one wins and the
difference is logged, because a shipment may already exist for what's stored. The
disagreeing delivery is still in `webhook_events` under its own id, so you can
see what the store actually sent. The one exception is the reused-id case above:
that delivery has no row of its own, since the id is taken. Losing an audit row
beats dropping an order.

## When a job fails

After `MAX_ATTEMPTS` (5) it stops: job `dead`, order `failed`, last error on the
row. Rows, not log lines, so you can find them.

```bash
npm run replay              # list what's parked and why
npm run replay ORD-123      # put one back
```

```bash
npm run reconcile           # or: npm run reconcile 1
```

Reconcile finds unshipped orders older than `RECONCILE_AFTER_MINUTES`, asks the
courier what exists for each, and either records what it finds or resets the job.
It never POSTs. Safe to run repeatedly and alongside workers: skips anything
pending or processing, and anything parked as `rejected` (a 4xx will just fail
again, so that needs a human). It also sweeps jobs a dead worker left in
`processing`, which is how those get recovered when no worker is running.

The retries mostly handle the created-then-timed-out case themselves, including
one last lookup before the final attempt gives up. Reconcile is for when that
doesn't happen: the worker died before it could look, the lookup itself failed,
or the job was parked while a shipment existed.

In Docker: `docker compose exec api node dist/scripts/replay.js`, same for
`reconcile.js`.

## Numbers

Local, mock at its default failure rates, three workers, one API:

- 1000 deliveries at 100 concurrent: 419 req/s, p50 196ms, p99 404ms, max 427ms.
  Nothing over a second.
- 500 jobs drained in 53s. 499 shipped, one parked after five consecutive 500s,
  replayed by hand.
- 500 shipments for 500 orders. No reference with two.

Latency climbs with concurrency because requests queue for a DB connection
(Sequelize pools 5). First thing I'd tune if the 1s budget got close.

## Next, with more time

- `orders/updated` and `orders/cancelled`. Right now a second `orders/create`
  with different content keeps the first payload and logs the difference; real
  changes belong on their own topics.
- `job_attempts` table so a replay doesn't throw away the error history.
- At volume: same queue interface, transactional outbox + BullMQ or SQS behind
  it, so something pushes instead of polling.
- Redis token bucket per courier so all workers back off together on a 429, and
  a bigger attempt allowance for rate limits.
- Metrics on dead jobs, on reconcile finding anything, on queue depth. A dead job
  nobody looks at is a lost order. Structured logs with the order id.
- Keep the courier's raw requests and responses, which is what you want when a
  shipment looks wrong.

## Left out on purpose

- No auth beyond the HMAC.
- One secret for one store. Real multi-tenancy means a secret per shop and a shop
  id on every row.
- No UI. The scripts and psql are the operator interface.
- Nothing about deployment. The compose file is for running it locally and the
  password is `postgres`.
- Reconcile is a script, not a scheduled job.
- No circuit breaker, so a courier that's fully down means every job retries on
  its own.
- Order ids above 2^53 aren't really handled. The column is text, but
  `JSON.parse` has already lost the precision by then. A bigint-aware parser
  would fix it.

## Mock courier

`mock-courier.js`, plain JS, shipments in an array. `npm run dev` starts it, or
on its own:

```bash
npm run mock
```

```bash
curl localhost:4000/health
```

POST returns `201 {shipmentId, reference}`, `GET /shipments?reference=` lists
them, and the same reference twice gives you two shipments, which is the reason
for the lookup.

~20% of posts 500, ~10% 429 with `Retry-After`, ~10% create then hang. One
`Math.random()` per request against the cumulative rates, so 20/10/10 is 40%
failures and not something else. Rates are env vars, set one to `0` to turn that
behaviour off, which is what the tests do.
