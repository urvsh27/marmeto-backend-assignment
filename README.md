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

The mock courier, in another terminal:

```bash
npm run mock
```

```bash
curl localhost:4000/health
```

The worker and a single `docker compose up` that runs everything come in later
steps.

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
