# Distributed Wagering Processor

Solution to the [Jungle Gaming technical challenge](./CHALLENGE.md) — a distributed
financial service that processes wagering transactions with financial
correctness, multi‑instance concurrency safety, persistent idempotency and a
transactional outbox.

Design decisions, trade‑offs and current scope live in **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

> **Scope note:** implemented — wallet creation, `BET` / `WIN` / `LOSS`,
> `REFUND` / `ROLLBACK` with reference resolution, the pending‑reference worker
> (out‑of‑order), the **SQS consumer** (persistent inbox, ack‑after‑commit, DLQ),
> hot‑wallet concurrency, idempotency, outbox + relay, ledger, reconciliation,
> health checks, **JSON logs + Prometheus metrics** (`GET /metrics`). Optional /
> not done: OpenTelemetry, a dashboard, a load test (see
> [ARCHITECTURE.md](./ARCHITECTURE.md) §Roadmap).

---

## Stack

| | |
|---|---|
| Runtime / package manager / test runner | Bun 1.x |
| Language | TypeScript (strict) |
| Framework | NestJS 10 |
| Database | PostgreSQL 16 |
| ORM | MikroORM 6 (pessimistic locking, UoW, versioned migrations) |
| Messaging | AWS SQS via LocalStack |
| Orchestration | Docker Compose |

## Prerequisites

- [Bun](https://bun.sh) `>= 1.4` — `curl -fsSL https://bun.sh/install | bash`
- Docker + Docker Compose

## Setup

```bash
# 1. install dependencies
bun install

# 2. environment
cp .env.example .env
#   The Postgres host port defaults to 5439 to avoid clashing with a local
#   Postgres on 5432. Override with DB_HOST_PORT / DATABASE_URL if needed.

# 3. start infrastructure (Postgres + LocalStack, queues auto-created)
docker compose up -d

# 4. run migrations
bun run db:up

# 5. start the API (SQS consumer + outbox relay + pending-reference worker run in-process)
bun run start:dev            # http://localhost:3000

# …or run the API and the workers as separate processes:
bun run start                # HTTP only  (set SQS_CONSUMER_ENABLED=false etc.)
bun run worker               # headless: consumer + outbox relay + pending-reference
```

Queues created by `scripts/localstack-init.sh`:
`wager-transactions.fifo`, `wager-transactions-dlq.fifo`, `wager-events.fifo`.

## Commands

| Command | Description |
|---|---|
| `bun run start` | start the HTTP API (+ in-process workers) |
| `bun run start:dev` | start with watch mode |
| `bun run worker` | headless workers only (SQS consumer, outbox relay, pending-reference) |
| `bun run db:up` / `db:down` / `db:fresh` / `db:pending` | migrations |
| `bun run test` | unit + integration + concurrency (fast inner loop) |
| `bun run test:unit` | domain unit tests only (no I/O) |
| `bun run test:integration` | real Postgres + LocalStack |
| `bun run test:concurrency` | real-parallelism race tests (one process) |
| `bun run test:multi-instance` | §13.4 — spawns **3 separate app processes** vs. one DB |
| `bun run test:all` | everything, including multi-instance |
| `bun run lint` | `tsc --noEmit` |

> Integration / concurrency / multi-instance tests need `docker compose up -d`
> and `bun run db:up` first. They boot real Nest servers and truncate tables
> between cases. `test:multi-instance` is kept out of the default `bun run test`
> because it launches 3 OS processes — see [ARCHITECTURE.md](./ARCHITECTURE.md)
> §"Multi-instance test".

## API quick tour

```bash
# create a wallet with an opening balance
curl -sX POST localhost:3000/wallets -H 'content-type: application/json' -d '{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "1000.00", "currency": "BRL" }
}'

# submit a bet (Idempotency-Key is required)
curl -sX POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:tx-123' -d '{
    "providerId": "provider-a",
    "externalTransactionId": "tx-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "<wallet id from step 1>",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'

curl -s localhost:3000/wallets/<walletId>
curl -s "localhost:3000/wallets/<walletId>/ledger?limit=50"
curl -sX POST localhost:3000/wallets/<walletId>/reconciliation
curl -s localhost:3000/health/ready
curl -s localhost:3000/metrics
```

### Observability

Structured JSON logs on stdout, one object per line, each carrying the request's
`correlationId` (plus `walletId` / `transactionId` / `providerId` / `messageId`
as they become known) — propagated with `AsyncLocalStorage` across HTTP, the SQS
consumer and the workers. No `Money` values or raw payloads are ever logged.
`GET /metrics` serves a Prometheus exposition (own lightweight implementation)
covering transactions by status/kind, idempotency replays, SQS retries + DLQ,
pending‑reference retries, wallet‑lock wait/contention, outbox lag + backlog, and
processing latency. Details and the full metric list: **[ARCHITECTURE.md](./ARCHITECTURE.md) §10**.

| Endpoint | |
|---|---|
| `POST /wallets` | create wallet (`201`; `409` if `playerId+currency` exists) |
| `GET /wallets/:id` | wallet snapshot |
| `GET /wallets/:id/ledger?cursor=&limit=` | opaque cursor pagination |
| `POST /wallets/:id/reconciliation` | stored balance vs. ledger‑rebuilt balance |
| `POST /wagering/transactions` | submit — see status mapping in ARCHITECTURE.md §7 |
| `GET /wagering/transactions/:id` | by internal id |
| `GET /providers/:providerId/wagering/transactions/:externalId` | by provider ref |
| `GET /health/live` · `GET /health/ready` | liveness · readiness — PostgreSQL + SQS (no auth) |
| `GET /metrics` | Prometheus text format (no auth) |

## Background workers

Run in-process with the API (`bun run start`) or as a separate replica
(`bun run worker`); toggle each with `*_ENABLED=false`.

| Worker | Job |
|---|---|
| **SQS consumer** | polls `wager-transactions.fifo` → same use case → ack after commit; permanent errors → DLQ, transient → backoff then DLQ |
| **Outbox relay** | publishes committed integration events to `wager-events.fifo` (`FOR UPDATE SKIP LOCKED`, dedup by event id) |
| **Pending-reference worker** | retries `REFUND`/`ROLLBACK` whose reference hasn't arrived yet |

### Pending-reference (out-of-order `REFUND` / `ROLLBACK`)

When a `REFUND`/`ROLLBACK` is submitted before the transaction it references,
it is stored as `PENDING_REFERENCE` (HTTP `202`), not rejected. A scheduled
worker (`PENDING_REFERENCE_POLL_INTERVAL_MS`, default 5s) retries resolution by
`(providerId, referenceExternalTransactionId)` under the wallet lock, reusing the
same reversal logic as the sync path. Backoff is exponential
(`0, 2, 4, 8, … , 300s`, i.e. **≈ 13.5 min** total) over `maxAttempts` (10)
tries; then the transaction becomes `REJECTED` with `failureCode:
REFERENCE_NOT_FOUND` and a `WagerTransactionRejected` event — all in one SQL
transaction. Values and the rationale for ~14 min are in
[ARCHITECTURE.md](./ARCHITECTURE.md) §"Pending reference"; every knob is
env-overridable (`PENDING_REFERENCE_*`).

## Project layout

```
src/domain/        pure domain — Money, Wallet, WagerTransaction, reversal, events
src/application/   use cases + ports (+ ApplicationModule)
src/infra/         MikroORM entities/mappers/UoW, SQS consumer + client, outbox relay,
                   pending-reference worker, auth, observability (JSON logger,
                   correlation ALS, Prometheus registry + metric set)
src/http/          controllers, DTOs, exception filter, correlation middleware
src/main.ts        HTTP + in-process workers   ·   src/worker.ts   headless workers
scripts/db.ts      Bun-friendly migration runner
test/              unit / integration / concurrency
```
