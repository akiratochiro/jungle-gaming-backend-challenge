# Distributed Wagering Processor

Solution to the [Jungle Gaming technical challenge](./CHALLENGE.md) — a distributed
financial service that processes wagering transactions with financial
correctness, multi‑instance concurrency safety, persistent idempotency and a
transactional outbox.

Design decisions, trade‑offs and current scope live in **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

> **Scope note:** implemented — wallet creation, `BET` / `WIN` / `LOSS`,
> `REFUND` / `ROLLBACK` with reference resolution, the pending‑reference worker
> (out‑of‑order), hot‑wallet concurrency, idempotency, outbox + relay, ledger,
> reconciliation, health checks. Not yet wired: the SQS consumer, DLQ handling,
> metrics/JSON logs (see [ARCHITECTURE.md](./ARCHITECTURE.md) §Roadmap).

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

# 5. start the API (outbox relay runs in-process)
bun run start:dev            # http://localhost:3000
```

Queues created by `scripts/localstack-init.sh`:
`wager-transactions.fifo`, `wager-transactions-dlq.fifo`, `wager-events.fifo`.

## Commands

| Command | Description |
|---|---|
| `bun run start` | start the HTTP API |
| `bun run start:dev` | start with watch mode |
| `bun run db:up` / `db:down` / `db:fresh` / `db:pending` | migrations |
| `bun test` | all tests (unit + integration + concurrency) |
| `bun run test:unit` | domain unit tests only (no I/O) |
| `bun run test:integration` | real Postgres + LocalStack |
| `bun run test:concurrency` | real-parallelism race tests |
| `bun run lint` | `tsc --noEmit` |

> Integration and concurrency tests need `docker compose up -d` and `bun run db:up`
> first. They boot a real Nest HTTP server and truncate tables between cases.

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
```

| Endpoint | |
|---|---|
| `POST /wallets` | create wallet (`201`; `409` if `playerId+currency` exists) |
| `GET /wallets/:id` | wallet snapshot |
| `GET /wallets/:id/ledger?cursor=&limit=` | opaque cursor pagination |
| `POST /wallets/:id/reconciliation` | stored balance vs. ledger‑rebuilt balance |
| `POST /wagering/transactions` | submit — see status mapping in ARCHITECTURE.md §7 |
| `GET /wagering/transactions/:id` | by internal id |
| `GET /providers/:providerId/wagering/transactions/:externalId` | by provider ref |
| `GET /health/live` · `GET /health/ready` | liveness · readiness (no auth) |

## Project layout

```
src/domain/        pure domain — Money, Wallet, WagerTransaction, events
src/application/   use cases + ports
src/infra/         MikroORM entities/mappers/UoW, SQS, outbox relay, auth
src/http/          controllers, DTOs, exception filter
scripts/db.ts      Bun-friendly migration runner
test/              unit / integration / concurrency
```
