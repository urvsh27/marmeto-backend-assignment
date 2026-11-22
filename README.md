# marmeto-backend-assignment

Service that takes `orders/create` webhooks from a store and creates a shipment
with a courier partner.

The courier is unreliable. It rate limits, returns 5xx, and sometimes creates the
shipment and then times out on us. The store can also deliver the same webhook
more than once. So the webhook handler only saves the order and returns, and a
background worker does the courier call with retries.

Node 20, TypeScript, Express, Postgres. Sequelize for models, Umzug for
migrations. The job queue is a table in Postgres. API and worker run as separate
processes.

## How to run

```bash
npm install
cp .env.example .env
```

Postgres. There is no app container yet, so compose only brings up the database:

```bash
docker compose up -d postgres
```

```bash
npm run migrate
```

`npm run migrate down` rolls back the last migration. Set `DB_LOGGING=true` in
`.env` if you want to see the SQL.

If you already run Postgres locally, skip compose and point `DATABASE_URL` at
your own instance instead.

The API:

```bash
npm run dev
```

```bash
curl localhost:3000/health
```

### Tests

```bash
npm test
```

Vitest and Supertest against a real Postgres, not mocks. The suite uses its own
database (`marmeto_test` by default, `TEST_DATABASE_URL` to change it); it is
created and migrated on first run, so the only requirement is that Postgres is
up. Dev data is never touched.

They cover the two things most likely to break: signature verification, and the
duplicate handling. The duplicate tests assert row counts, not just status
codes, including ten simultaneous deliveries of one order ending up as one order
and one job.

```bash
npm run typecheck
```

### Sending a signed webhook

```bash
npm run send-webhook
```

That sends four requests for one order and prints what came back:

```
new order                        202  {"orderId":"ORD-...","duplicate":false}
same webhook id again            200  {"orderId":"ORD-...","duplicate":true}
new webhook id, same order       200  {"orderId":"ORD-...","duplicate":true}
tampered body                    401  {"error":"invalid signature"}
```

Both duplicate paths from the spec, plus a bad signature. It exits non-zero if
any of them misbehaves, so it works as a smoke test. Pass an order id to reuse
one:

```bash
npm run send-webhook ORD-123
```

Run that twice and the first line comes back `200 duplicate:true` instead of
`202`, because the order is already stored.

`POST /webhooks/orders-create` checks an HMAC-SHA256 of the raw body, base64, in
the `X-Shop-Hmac-Sha256` header, against `WEBHOOK_SECRET`. Anything that doesn't
match gets a 401. The same thing by hand:

```bash
BODY='{"id":1001,"line_items":[{"sku":"A","quantity":2}],"shipping_address":{"city":"Pune"}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -binary | base64)
curl -i -X POST localhost:3000/webhooks/orders-create \
  -H 'content-type: application/json' \
  -H "X-Shop-Hmac-Sha256: $SIG" \
  -H 'X-Shop-Webhook-Id: WH-1' \
  -d "$BODY"
```

Change a byte of the body without re-signing and it's a 401.

A new order gets `202 {"orderId":"1001","duplicate":false}`. 202 rather than 200
because the courier hasn't been called yet, the job is only queued. Anything
already known gets `200 {"duplicate":true}` and no second job.

The endpoint writes three rows in one transaction: the delivery into
`webhook_events`, the order into `orders`, and a job into `jobs`. They commit
together, so there is no way to end up with an order nobody will ship.

Duplicates are caught by unique keys rather than by looking first:

- same `X-Shop-Webhook-Id` -> the `webhook_events` insert does nothing, we stop there
- same order id on a new webhook id -> the delivery is recorded, the order is not
  overwritten, no job is queued

If a redelivery carries a payload that disagrees with the stored one, the first
payload wins and the difference gets logged. A shipment may already exist for
what we stored, so quietly replacing it would be worse. The delivery is kept in
`webhook_events` either way, so you can always see what the store actually sent.
Real changes arrive on `orders/updated` and `orders/cancelled`, which are out of
scope here.

The mock courier, in another terminal:

```bash
npm run mock
```

```bash
curl localhost:4000/health
```

The worker and a single `docker compose up` that runs everything come in later
steps.

## Data model

Three tables, created by one migration.

- `webhook_events` keyed on the `X-Shop-Webhook-Id`, one row per delivery
  including duplicates, and it keeps the payload that came with it
- `orders` keyed on the store's order id as text, with the payload, a status of
  `received` / `shipped` / `failed`, and the courier's shipment id once we have one
- `jobs` is the queue. One row per order and job type, enforced by a unique key,
  so a duplicate job cannot be inserted even if something tries

Everything that touches the `jobs` table goes through `src/queue/jobs.ts`.
Nothing else writes to it. Moving to BullMQ or SQS later should mean rewriting
that one file, and the idempotency would still hold because it lives in the
unique keys rather than in the queue.

Two check constraints on `orders` are worth pointing out. One limits `status` to
the three values. The other says an order cannot be `shipped` unless
`shipment_id` is set, which is the mistake this whole service is trying not to
make.

## Mock courier

`mock-courier.js` fakes the courier partner. Plain JS, keeps shipments in an
array, no database.

- `POST /shipments` with `{ reference, address, items }` returns `201 { shipmentId, reference }`
- `GET /shipments?reference=<orderId>` returns the shipments for that reference
- posting the same `reference` twice creates two shipments. it isn't idempotent,
  which is why the worker checks by reference before it creates anything

It fails on purpose. Set a rate to `0` to switch that behaviour off, which is
what the tests do:

| var | default | what it does |
| --- | --- | --- |
| `COURIER_PORT` | `4000` | port it listens on |
| `COURIER_FAIL_RATE_500` | `0.2` | share of POSTs that return 500 |
| `COURIER_FAIL_RATE_429` | `0.1` | share that return 429 with `Retry-After` |
| `COURIER_FAIL_RATE_TIMEOUT` | `0.1` | share that create the shipment, then hang |
| `COURIER_HANG_MS` | `10000` | how long the hang lasts |
| `COURIER_RETRY_AFTER` | `2` | seconds sent in the `Retry-After` header |

Each request does one `Math.random()` roll and checks it against the rates added
up, so 20/10/10 really means 40% failures.
