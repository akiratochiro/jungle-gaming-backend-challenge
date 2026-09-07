# Distributed Wagering Processor

Solution to the [Jungle Gaming technical challenge](./CHALLENGE.md) — a distributed
financial service that processes wagering transactions with financial
correctness, multi‑instance concurrency safety, persistent idempotency and a
transactional outbox.

Design decisions, trade‑offs and current scope live in **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

> **Scope note — every scored requirement is implemented:** wallet creation,
> `BET` / `WIN` / `LOSS`, `REFUND` / `ROLLBACK` with reference resolution, the
> pending‑reference worker (out‑of‑order), the SQS consumer (persistent inbox,
> ack‑after‑commit, DLQ), hot‑wallet concurrency, idempotency, transactional
> outbox + relay, immutable ledger, reconciliation, health checks, JSON logs +
> Prometheus metrics (`GET /metrics`), reversible migrations, and real
> integration / concurrency / multi‑instance tests.
> The only optional differentials left undone are the **load test**
> (`bun run test:load`), OpenTelemetry, a dashboard and double‑entry bookkeeping
> — all explicitly optional in the brief.

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

- [Bun](https://bun.sh) `>= 1.4` — `curl -fsSL https://bun.sh/install | bash`.
  The installer adds `~/.bun/bin` to your shell profile — **open a new terminal
  (or `source ~/.zshrc` / `~/.bashrc`) so `bun` is on `PATH`**. Every
  `package.json` script shells out to `bun`, so it must be resolvable.
- Docker + Docker Compose

## Setup

```bash
# 1. install dependencies
bun install

# 2. environment
cp .env.example .env
#   Postgres is published on host port 5439 (see DB_HOST_PORT in .env) rather
#   than 5432, to avoid clashing with a Postgres you may already run locally.
#   Change DB_HOST_PORT *and* DATABASE_URL's port together if you want another.

# 3. start infrastructure (Postgres + LocalStack, queues auto-created)
docker compose up -d --wait          # --wait blocks until both are healthy

# 4. run migrations
bun run db:up

# 5. run the whole service in one process (HTTP + SQS consumer + outbox relay
#    + pending-reference worker):
bun run start:dev            # watch mode, http://localhost:3000
bun run start                # same, without watch

# …or split the HTTP API and the workers onto separate processes / replicas:
bun run start:http           # HTTP only  (WORKERS_ENABLED=false)
bun run worker               # headless: SQS consumer + outbox relay + pending-reference
```

Queues created by `scripts/localstack-init.sh`:
`wager-transactions.fifo`, `wager-transactions-dlq.fifo`, `wager-events.fifo`.

## Commands

| Command | Description |
|---|---|
| `bun run start` / `start:dev` | full service in one process — HTTP **+** all 3 workers (`start:dev` adds watch) |
| `bun run start:http` | HTTP API only, no workers (`WORKERS_ENABLED=false`) |
| `bun run worker` | headless workers only (SQS consumer, outbox relay, pending-reference) |
| `bun run db:up` / `db:down` / `db:fresh` / `db:pending` | migrations |
| `bun run test` | unit + integration + concurrency (fast inner loop) |
| `bun run test:unit` | domain unit tests only (no I/O) |
| `bun run test:integration` | real Postgres + LocalStack |
| `bun run test:concurrency` | real-parallelism race tests (one process) |
| `bun run test:multi-instance` | §13.4 — spawns **3 separate app processes** vs. one DB |
| `bun run test:all` | everything, including multi-instance |
| `bun run lint` | `tsc --noEmit` |

> **Before running any I/O test suite (`test`, `test:integration`,
> `test:concurrency`, `test:multi-instance`, `test:all`), stop every running API
> / worker process** — e.g. `pkill -f 'src/main.ts'; pkill -f 'src/worker.ts'`.
> The tests spin up their own Nest instances against the shared Postgres and
> LocalStack queues; a leftover in-process **SQS consumer will steal the test
> messages** and the tests fail non-deterministically. `bun run test:unit` has
> no I/O and is always safe.
>
> The I/O suites also need `docker compose up -d --wait` and `bun run db:up`
> first; they boot real Nest servers and truncate tables between cases.
> `test:multi-instance` is kept out of the default `bun run test` because it
> launches 3 OS processes — see [ARCHITECTURE.md](./ARCHITECTURE.md)
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
consumer and the workers. No `Money` values or raw payloads are ever logged (the
one deliberate exception is a reconciliation divergence, which logs the residual
delta). `GET /metrics` serves a Prometheus exposition (own lightweight
implementation) covering transactions by status/kind, idempotency replays, SQS
retries + DLQ, pending‑reference retries, wallet‑lock wait/contention, outbox lag
+ backlog, reconciliation divergences, and processing latency. Details and the
full metric list: **[ARCHITECTURE.md](./ARCHITECTURE.md) §10**.

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

By default they run **in-process** with the API (`bun run start` / `start:dev`).
To scale them out, run the HTTP API with `bun run start:http`
(`WORKERS_ENABLED=false`) and the workers as one or more `bun run worker`
replicas. Individual workers can also be toggled with
`SQS_CONSUMER_ENABLED` / `OUTBOX_RELAY_ENABLED` /
`PENDING_REFERENCE_WORKER_ENABLED` `=false`. All are safe to run on multiple
instances (wallet lock + `FOR UPDATE SKIP LOCKED` + inbox).

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
