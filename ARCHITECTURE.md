# Architecture & Decisions

> Status. Implemented end‑to‑end: wallet creation (`OPENING`), `BET` / `WIN` /
> `LOSS`, `REFUND` / `ROLLBACK` (with reference resolution), the
> `PENDING_REFERENCE` worker (out‑of‑order references), the **SQS consumer**
> (persistent inbox, ack‑after‑commit, DLQ), pessimistic hot‑wallet concurrency,
> persistent idempotency, transactional outbox + relay, ledger, reconciliation,
> health checks, **JSON structured logs + Prometheus metrics** (`/metrics`).
> **Not implemented** (optional): OpenTelemetry, a bundled dashboard, a load
> test. See *Roadmap*.

---

## 1. Layering

```
src/
  domain/        pure TS. No NestJS, no ORM, no I/O. Invariants live here.
    shared/      Money, DomainError, canonical JSON + hashing
    wallet/      Wallet aggregate, WalletLedgerEntry, wallet errors
    wager/       WagerTransaction aggregate, enums, FailureCode, errors
    events/      IntegrationEvent<T> abstract + concrete subclasses
  application/   use cases + ports (abstract classes used as DI tokens)
  infra/         MikroORM entities/mappers/UoW, SQS client, outbox relay, auth
  http/          controllers, DTOs, exception filter
```

The domain never imports from `application`, `infra` or `http`. Aggregates use
**private constructors + static factories** (`create` / `open` validate,
`rehydrate` does not). Persistence maps to/from the domain explicitly in
`infra/database/mappers.ts` — the ORM identity map is never handed a domain
object.

## 2. ORM — MikroORM

Chosen over TypeORM for the explicit **Unit of Work** (`em.transactional()`),
`LockMode.PESSIMISTIC_WRITE`, and first‑class migrations. Persistence model:

- Entities are **plain persistence classes** (`*.entity.ts`), decoupled from the
  domain. No domain type leaks a decorator.
- `Money` maps to two columns: `*_amount numeric(20,2)` + `currency varchar(3)`.
  `numeric` is exact; MikroORM returns it as a string, which is exactly the
  representation `Money.rehydrate` expects. **No `float`/`number` anywhere near
  money** — enforced by `Money` refusing any input that is not a plain decimal
  string with ≤ 2 fractional digits.
- Transaction strategy: every write path runs inside a single
  `em.transactional(async em => …)`. Wallet, ledger, wager transaction, inbox
  and outbox rows all flush inside that one SQL transaction (§5).

## 3. `Money`

- Value object, immutable, `private constructor`.
- `from()` is the **entry contract**: rejects `NaN`, `Infinity`, scientific
  notation, empty string, thousands separators, `> 2` decimal places and
  negative amounts (regex `^-?\d+(\.\d{1,2})?$` then `decimal.js`).
- `rehydrate()` is the internal reconstruction path — allows negative
  intermediate values, still exact.
- Arithmetic is delegated to `decimal.js` configured with
  `ROUND_HALF_EVEN`, `toExpNeg/Pos` pushed out so it never emits exponent
  notation. Different‑currency operations throw `MoneyCurrencyMismatchError`.
- Single currency (`BRL`) is assumed operationally, but the model stays
  multi‑currency and currency conflicts are tested (unit + wallet + wager).

## 4. Concurrency — pessimistic row lock on the wallet

The **unit of concurrency is `walletId`**. `WagerUnitOfWork.runForWallet(walletId)`:

1. opens a SQL transaction (`READ COMMITTED`);
2. `SELECT … FOR UPDATE` on the single `wallets` row
   (`LockMode.PESSIMISTIC_WRITE`);
3. runs the use case with a transaction‑scoped context;
4. commits (releasing the lock) or rolls back.

Why pessimistic and not optimistic:

- The hot‑wallet path is *read balance → decide → write balance + ledger*.
  Under contention, optimistic retry loops turn into livelock exactly when it
  hurts. A row lock serialises **only the contending wallet**; different wallets
  never block each other (requirement in §8), and the lock is a single indexed
  PK lookup.
- Correctness does **not** depend on the number of app instances: the lock is in
  PostgreSQL. Three+ instances contend on the same row and serialise.
- `version` is still kept and incremented **only when the balance changes**, so
  optimistic checks / event ordering downstream remain possible.

The DB is the final authority regardless of the lock:

| Invariant | Schema enforcement |
|---|---|
| One wallet per `(playerId, currency)` | `UNIQUE (player_id, currency)` |
| Balance never negative | `CHECK (balance_amount >= 0)` + `CHECK (balance_after >= 0)` on ledger |
| One ledger entry per wallet per transaction | `UNIQUE (wallet_id, transaction_id)` |
| Ledger arithmetic correct | `CHECK ((direction='CREDIT' AND before+amount=after) OR (direction='DEBIT' AND before-amount=after))` |
| Ledger immutable | `BEFORE UPDATE OR DELETE` trigger raises |
| Idempotency key unique | `UNIQUE (idempotency_key)` |
| Provider transaction unique | `UNIQUE (provider_id, external_transaction_id)` |
| A reference reversed at most once per kind | partial `UNIQUE (reference_transaction_id, kind) WHERE status='PROCESSED' AND kind IN ('REFUND','ROLLBACK')` |
| `REFUND`/`ROLLBACK` carry a reference | `CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL)` |

### Mandatory scenario (§8) — covered by `test/concurrency/hot-wallet.spec.ts`

`100.00` balance, two simultaneous `80.00` bets → exactly one `PROCESSED`, one
`REJECTED / INSUFFICIENT_FUNDS`, final balance `20.00`, exactly **one** debit
entry, reconciliation consistent. Also: the same bet fired **50× in parallel**
→ one debit, 49 idempotent replays, one `transactionId`.

The same two scenarios run again in `test/multi-instance` across **3 separate
application processes**, requests spread between them — §13.4, see §11.

## 5. Idempotency

- The `Idempotency-Key` **header is the source of truth**. Default value
  `"{providerId}:{externalTransactionId}"`, but any client‑supplied key is
  honoured verbatim.
- `payloadHash = sha256( canonicalJSONStringify( businessSubset ) )`.
  `canonicalJSONStringify` sorts object keys at every level and drops
  `undefined`; transport metadata (the header, SQS envelope) is **not** hashed.
  Business subset: `providerId, externalTransactionId, playerId, walletId,
  roundId, gameId, kind, money{amount,currency}, referenceExternalTransactionId`.
- Flow inside the wallet lock:
  1. look up `wager_transactions` by `idempotency_key`;
  2. found + same `payloadHash` → return the **original stored result**
     (`status`, `failureCode`, and the balance observed at processing time,
     persisted in `result_balance_amount`), `idempotentReplay: true`;
  3. found + different `payloadHash` → `IdempotencyConflictError` → HTTP `409`
     (**not** a replay);
  4. not found → process, insert with the unique key.
- Persistence, not memory: the check is a `SELECT` against a `UNIQUE` column;
  the insert would fail the constraint even if two requests somehow raced past
  the lock.

## 6. Transactional outbox

`enqueueOutbox` writes `outbox_messages` rows **in the same `em.transactional`**
as the wallet/ledger/wager writes. Events are never published before commit.

`OutboxRelay` (runs in‑process by default; also runnable standalone):

- `SELECT … WHERE published_at IS NULL AND (next_attempt_at IS NULL OR
  next_attempt_at <= now()) ORDER BY occurred_at LIMIT n FOR UPDATE SKIP LOCKED`
  → multiple relays never grab the same row.
- publish to SQS FIFO with `MessageDeduplicationId = eventId`,
  `MessageGroupId = aggregateId` (per‑wallet ordering) → a duplicate publish is
  absorbed by the broker and is safe for consumers regardless.
- `published_at` is set **only after** a successful send. Crash between commit
  and publish just leaves the row pending for another relay (covered by
  `test/integration/outbox.spec.ts`).
- Send failure → exponential backoff via `attempts` / `next_attempt_at`.

Events implemented: `WagerTransactionProcessed` (incl. `LOSS`),
`WagerTransactionRejected`, `WalletBalanceChanged` (only when the balance moved),
`WagerTransactionPendingReference` (reference missing). A mere worker reschedule
emits nothing; only a state change does.

Envelope: `IntegrationEvent<T>` is an **abstract class**; `eventType` and
`version` live on the concrete subclass, not at the call site. `data` always
carries `MoneyProps` (decimal strings), never a `Money` instance.

## 6b. Reversals — `REFUND` / `ROLLBACK`

Rules live in one place, `domain/wager/reversal.ts` (`validateReversal`) +
`application/wager/apply-reversal.service.ts`, shared by the synchronous submit
path and the pending‑reference worker.

- **Reference resolution**: by `(providerId, referenceExternalTransactionId)` —
  the provider's id, never the internal one. The resolved reference must be
  `PROCESSED` and share **provider, player, wallet, currency and round**.
- `REFUND` targets only `BET`; `ROLLBACK` targets `BET`, `WIN` or `REFUND`
  (`REFERENCE_KIND_NOT_ALLOWED` otherwise).
- **Amount must equal the reference** — partial reversal is out of scope
  (`REVERSAL_AMOUNT_MISMATCH`).
- **Direction**: `REFUND` always credits; `ROLLBACK` inverts the reference's
  ledger direction (`WagerTransaction.ledgerDirectionFor(reference)`).
- **Reverse once per kind** (rule 7.4): checked in‑app *and* enforced by the
  partial unique index `(reference_transaction_id, kind) WHERE status='PROCESSED'
  AND kind IN ('REFUND','ROLLBACK')`. A second attempt →
  `REFERENCE_ALREADY_REVERSED`. All reversals of a reference touch the same
  wallet, so the wallet lock serialises them; the index is the race backstop.
  *Known edge, documented:* a `BET` may be both `REFUND`ed and `ROLLBACK`ed
  (different kinds) — the rule is "twice by the same kind".
- **Overdraw**: a `ROLLBACK` debit that would push the balance negative →
  `REVERSAL_WOULD_OVERDRAW`, **distinct** from `INSUFFICIENT_FUNDS` (rule 7.9),
  persisted and auditable.

### Pending reference (out‑of‑order, §7.1)

`REFUND`/`ROLLBACK` may arrive before the transaction they reference. When
resolution by `(providerId, referenceExternalTransactionId)` finds nothing, the
reversal is **not rejected** — it is persisted as `PENDING_REFERENCE` (HTTP
`202`), `WagerTransactionPendingReference` goes to the outbox, and a background
worker keeps retrying.

**Worker** — `PendingReferenceWorker`, started by `main.ts` and by
`src/worker.ts` (headless). Every `PENDING_REFERENCE_POLL_INTERVAL_MS` (5s) it
scans

```sql
SELECT id, wallet_id FROM wager_transactions
WHERE status = 'PENDING_REFERENCE'
  AND (next_attempt_at IS NULL OR next_attempt_at <= now())
ORDER BY created_at ASC LIMIT n
```

(served by the partial index `(status, next_attempt_at) WHERE
status='PENDING_REFERENCE'`) and runs `ResolvePendingReferenceUseCase` per row
**inside that row's wallet lock**. That use case re‑reads the row under the lock
and bails out (`noop`) if another instance already moved it or pushed its
`next_attempt_at` into the future — so running the worker on several instances is
safe without any distributed lock. Resolution reuses `ApplyReversalService`, so
the REFUND/ROLLBACK rules (§6b) are applied identically to the synchronous path;
the ledger entry, wallet update and the `WagerTransactionProcessed` /
`WalletBalanceChanged` (or `WagerTransactionRejected`) events all commit in the
**same SQL transaction**. A mere reschedule emits no event.

**Backoff & budget** — `ReferenceResolutionPolicy` (all env‑overridable):

| param | default | |
|---|---|---|
| `baseDelayMs` | `2000` | first backoff |
| `capDelayMs` | `300000` | max backoff |
| `maxAttempts` | `10` | attempts before giving up |

First look is immediate; then the gap before attempt *n* is
`min(base·2^(n-2), cap)` → `0, 2, 4, 8, 16, 32, 64, 128, 256, 300` seconds.
**A reference therefore has ≈ 13.5 minutes** (plus up to one 5s poll interval of
slack per gap, so ~14–15 min wall‑clock) to show up.

*Why an attempt count and not a wall‑clock TTL, and why ~14 min:* out‑of‑order
delivery on a FIFO queue comes from redelivery after a visibility timeout or a
lagging consumer — seconds to a couple of minutes. 14 minutes clears that with a
wide margin while the exponential curve keeps the worker cheap (a stuck row is
polled ~10 times total, not every 5s forever). A provider whose reference is
genuinely delayed longer than that gets a clear, machine‑readable
`REFERENCE_NOT_FOUND` and can resubmit — which is safer than holding money
movements pending indefinitely.

**Budget exhausted** → `reject(REFERENCE_NOT_FOUND)` +
`WagerTransactionRejected` on the outbox, in one transaction. `PROCESSED` /
`REJECTED` are terminal, so the row is never scanned again.

## 6c. SQS consumer, inbox & DLQ

`SqsWagerConsumer` long‑polls `wager-transactions.fifo` and feeds every message
through the **same `SubmitWagerTransactionUseCase`** the HTTP endpoint uses
(`cmd.inbox` set). It is wired in `main.ts` for the API process and in
`src/worker.ts` for a headless replica; `bun run worker` runs the consumer +
outbox relay + pending‑reference worker with no HTTP.

**Message** (`type: "WagerTransactionRequested"`) — `parseWagerMessage` does
structural validation only; domain validation stays in the use case. The
envelope's own `messageId` (not the SQS `MessageId`) is the inbox key.

**Ack after commit**: the SQS `DeleteMessage` runs only after
`SubmitWagerTransactionUseCase` returns, i.e. after its SQL transaction
committed. A crash between commit and delete → redelivery → `claimInbox` finds
the row → the use case replays the original outcome → the consumer acks. One
debit, always (test: *crash after commit, before ack*).

**Inbox**: `inbox_messages` PK `(consumer_name, message_id)`. `claimInbox`
inserts the row **inside the same transaction** as the wallet/ledger/outbox
writes — so it commits or rolls back with them. An existing row ⟹ a prior
delivery already committed ⟹ replay.

**Error taxonomy** (challenge §10):

| Class | Examples | Action |
|---|---|---|
| business | `REJECTED` (insufficient funds, reference rules) | use case returns normally → **ack** |
| permanent | malformed body, bad `Money`, unknown wallet, idempotency conflict, `OPENING` via queue | **DLQ** immediately, with `failureReason` / `failedAt` / `sourceQueue` message attributes |
| transient | deadlock, dropped connection, unknown error | not deleted; `ChangeMessageVisibility` with exponential backoff (`base·2^(n-1)`, cap 900s). After `SQS_MAX_RECEIVE_COUNT` deliveries → **DLQ** |

The queue's own `RedrivePolicy` (`maxReceiveCount` = 5) is a safety net; the
consumer normally moves to the DLQ explicitly one delivery earlier so it can
attach the failure reason. Unknown errors default to *transient* — a redeploy
may fix them — and the receive‑count cap still bounds the retries.

**Graceful shutdown** (`SIGTERM` → `onModuleDestroy`): stop polling, await
in‑flight handlers (bounded by the visibility timeout). Anything not finished is
simply never deleted, so SQS makes it visible again — safe because of the inbox.

**FIFO**: a batch is fully awaited before the next poll, so per‑`MessageGroupId`
ordering is respected; different groups in a batch run concurrently and the
wallet lock keeps them correct.

## 7. HTTP status mapping

A provider can branch on the status code alone:

| Situation | Code |
|---|---|
| Malformed payload (DTO validation, bad `Money`, non‑submittable `kind`) | `400` |
| Unknown wallet | `404` |
| Idempotency key reused with a different payload / duplicate wallet | `409` |
| Accepted, applied → `PROCESSED` | `200` |
| Accepted, business rejection → `REJECTED` (+ `failureCode`) | `422` |
| Accepted, still resolving → `PENDING` / `PENDING_REFERENCE` | `202` |
| Transient infrastructure failure | `503` |

Mapping lives in one place: `WageringController.statusFor` for result statuses,
`DomainExceptionFilter` for thrown errors. Health endpoints are unauthenticated.

## 8. Failure codes

`src/domain/wager/failure-code.ts`. Notably `INSUFFICIENT_FUNDS` (a bet with no
balance) is **distinct** from `REVERSAL_WOULD_OVERDRAW` (a reversal that would
push the balance negative) — operationally different, per §7.9. Reference
problems are split: `REFERENCE_NOT_FOUND`, `REFERENCE_NOT_PROCESSED`,
`REFERENCE_MISMATCH`, `REFERENCE_KIND_NOT_ALLOWED`, `REFERENCE_ALREADY_REVERSED`.

## 9. Authentication — deliberately not implemented

Auth is not scored. `AuthGuard` is a **no‑op** and `ProviderIdentityPort` has a
`NoopProviderIdentity` binding. The design if implemented: an external OIDC IdP
(Keycloak in Compose), a `JwtAuthGuard` validating the bearer token, and
`ProviderIdentityPort.resolve()` returning the authenticated `providerId` to be
cross‑checked against the payload. **Queue messages are treated as a trusted
internal channel**, but the provider identity *in the message* is still subject
to the same domain validations (player owns wallet, currency matches, …).

## 10. Observability

### 10.1 Structured logs

**Format:** one JSON object per line on **stdout** (`src/infra/observability/json-logger.ts`,
registered as the Nest logger in `main.ts` and `worker.ts`). Every line:

```json
{"ts":"2026-…Z","level":"info","logger":"SubmitWagerTransactionUseCase",
 "msg":"wager transaction settled",
 "correlationId":"…","transactionId":"…","walletId":"…","providerId":"provider-a",
 "source":"http","kind":"BET","status":"PROCESSED"}
```

`ts`, `level`, `logger`, `msg` are always present; the five correlation fields
(`correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`) are
attached automatically whenever they are known; the rest is per-call structured
meta. Call sites pass `logger.log({ msg, ...fields })` — **never** a
string-interpolated value.

**Correlation propagation** — a single `AsyncLocalStorage`
(`src/infra/observability/correlation.ts`):

| Entry point | Scope opened by | Seed |
|---|---|---|
| HTTP | `CorrelationMiddleware` (global, `forRoutes('*')`) | inbound `X-Correlation-Id` or a fresh UUIDv7; echoed on the response |
| SQS consumer | `runWithCorrelation` per message | `sqs:<messageId>`, `messageId`, `providerId`, `walletId` |
| Outbox relay | `runWithCorrelation` per row | the event's own `correlationId`, `walletId`, `transactionId` |
| Pending-reference worker | `runWithCorrelation` per row | fresh UUIDv7, `transactionId`, `walletId` |

The use case then calls `enrichCorrelation({ transactionId, providerId, walletId })`
as those become known, so downstream log lines (and any nested worker) inherit
them.

### 10.2 What is kept out of the logs

- **No `Money` values.** `Money.toString()` / amounts never appear in a `msg` or
  a meta field. Balance movement is visible via metrics and the integration
  events, not logs. (`test/integration/observability.spec.ts` asserts a chosen
  amount never appears in any captured line.)
- **No raw payloads.** The HTTP body and the SQS message `data` object are never
  logged.
- **DLQ metadata** carries only `failureClass` (`malformed` / `permanent` /
  `exhausted`) + the exception class name — not the exception message, which
  could echo an invalid amount from the payload. The original body is on the DLQ
  for full detail.
- **5xx responses** log the error class name only (`DomainExceptionFilter`).

### 10.3 Metrics

**Mechanism:** a small dependency-free Prometheus implementation
(`src/infra/observability/prometheus.ts`, ~180 lines: `Counter`, `Gauge`,
`Histogram`, `Registry`). The metric set is small and fixed, the exposition
format is simple, and avoiding `prom-client` keeps the dependency list honest —
the trade-off is that we own the text-format correctness (covered by
`prometheus.spec.ts`).

**Exposed at `GET /metrics`** — unauthenticated (like health),
`Content-Type: text/plain; version=0.0.4`. Point a Prometheus scrape config at
it, or `curl localhost:3000/metrics`.

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `wager_transactions_total` | counter | `status`, `kind` | transactions by terminal status (covers HTTP, SQS, `OPENING`, and worker-resolved reversals) |
| `wager_idempotency_replays_total` | counter | — | duplicate request/message → original outcome replayed |
| `sqs_message_retries_total` | counter | — | messages whose visibility was extended for a transient retry |
| `sqs_messages_dlq_total` | counter | `reason` | messages moved to the DLQ (`malformed`/`permanent`/`exhausted`) |
| `pending_reference_retries_total` | counter | `outcome` | pending-reference attempts (`noop`/`rescheduled`/`processed`/`rejected`) |
| `wallet_lock_contended_total` | counter | — | pessimistic wallet locks that waited > 20 ms for another holder |
| `wallet_lock_wait_seconds` | histogram | — | time to acquire the wallet lock |
| `outbox_lag_seconds` | histogram | — | `publishedAt − occurredAt` per relayed event |
| `outbox_pending_messages` | gauge | — | unpublished outbox rows, `COUNT(*)` at scrape time |
| `wager_processing_seconds` | histogram | `source`, `outcome` | end-to-end latency of the shared use case |

*Lock contention with pessimistic locking* is not an error but a wait:
`wallet_lock_wait_seconds` times the `SELECT … FOR UPDATE`, and any wait past the
20 ms threshold also bumps `wallet_lock_contended_total`.

### 10.4 Health

Unchanged and unauthenticated. `GET /health/live` — process is up.
`GET /health/ready` — `SELECT 1` against PostgreSQL **and**
`GetQueueAttributes` against SQS; `503` with a per-check breakdown if either
fails. `/metrics` is likewise open.

### 10.5 Out of scope

OpenTelemetry traces and a bundled dashboard — explicitly optional in the brief,
not implemented. The `correlationId` on every log line and event envelope is the
hook a tracing layer would build on.

## 11. Testing

- **Unit** (`bun test src`, no I/O): `Money` scale/rounding/invalid input;
  `Wallet` invariants; `WagerTransaction` transitions + `ledgerDirectionFor`;
  `validateReversal` rules; currency conflict; idempotency‑key/payload divergence.
- **Integration** (`test/integration`, real PostgreSQL + real LocalStack SQS):
  outbox atomicity, relay publish‑once, crash‑pending rows, rejection emits no
  ledger entry; `REFUND`/`ROLLBACK` happy paths, reverse‑once rejection,
  amount‑mismatch, overdraw; **out‑of‑order** (challenge §13.7) — a `REFUND`
  before its `BET` **and** a `ROLLBACK` before its `WIN` both park as
  `PENDING_REFERENCE`, then the worker (manual drain *and* the real scheduled
  loop) resolves and applies the effect once the reference lands; budget
  exhausted → `REFERENCE_NOT_FOUND`. **SQS consumer** — happy path + ack,
  redelivery dedup, crash‑after‑commit replay, business rejection → ack,
  malformed / unknown wallet / `OPENING` → DLQ with a reason.
  **Observability** — every log line carries the request's `correlationId`
  (+ `walletId` / `transactionId` / `providerId`); a chosen `Money` amount and
  the raw payload never appear in any captured line; `/metrics` increments
  `wager_transactions_total{status,kind}`, `wager_idempotency_replays_total`,
  `sqs_messages_dlq_total{reason}`, `wager_processing_seconds`,
  `wallet_lock_wait_seconds` on the expected events; `/health/*` and `/metrics`
  answer without auth.
- **Policy / metrics** (`bun test src`): the backoff schedule and the ~13.5 min
  window; the Prometheus text format (counter series, histogram
  `_bucket`/`_sum`/`_count`, gauge collectors, label escaping).
- **Concurrency** (`test/concurrency`, real parallelism via `Promise.all`
  against a live HTTP server): the §8 scenario, 50× duplicate, idempotency
  conflict.
- **Multi‑instance** (`test/multi-instance`, `bun run test:multi-instance`) — see below.

`wallet.balance == balance rebuilt from the ledger` is asserted in every
concurrency / multi‑instance case — via `POST /wallets/:id/reconciliation`
*and* by re‑summing the ledger straight from SQL in the test process.

### Multi‑instance test (challenge §13.4)

`test/multi-instance/multi-instance.spec.ts` proves correctness with **three or
more genuinely separate processes**, not parallel requests inside one.

**Orchestration** — `test/helpers/cluster.ts`:

1. reserve 3 free TCP ports;
2. `Bun.spawn(['bun','run','src/main.ts'], { env: { PORT, … } })` **three times**
   — three independent OS processes, each its own Nest app, its own MikroORM
   connection pool, its own `EntityManager`, its own V8/JSC heap. They share
   *only* `DATABASE_URL` and the LocalStack endpoint (from `.env`);
3. the SQS consumer, outbox relay and pending‑reference worker are disabled in
   the spawned instances (`*_ENABLED=false`) so the test isolates the HTTP write
   path — those workers have their own tests;
4. wait for every instance's `GET /health/ready` (Postgres + SQS reachable);
5. a **fourth** MikroORM connection, owned by the test process itself
   (`test/helpers/db-admin.ts`), resets fixtures and reads back the final
   invariant. It never shares anything with the instances.

Teardown sends `SIGTERM` (Nest shutdown hooks) and `SIGKILL`s after 5s.

**Why spawned processes and not `docker compose --scale`:** for what §13.4
actually checks — several *unrelated* processes contending on one row — a
container adds only namespace isolation, which is irrelevant here. Process
spawns are an order of magnitude faster, need no image build / port‑mapping /
load‑balancer, and are deterministic in CI. The isolation that matters (separate
PG backends, zero shared memory) is identical.

**What it runs, requests spread across the instances:**

| Scenario | Distribution |
|---|---|
| §8 — wallet `100.00`, two `80.00` bets in parallel | bet A → instance 1, bet B → instance 2, wallet created on instance 0 |
| idempotency — same bet (same `Idempotency-Key`) ×50 in parallel | round‑robin over all 3 instances |
| four independent wallets, 5 bets each in parallel | round‑robin over all 3 instances |

Every case asserts `wallets.balance_amount == Σ(ledger CREDIT − DEBIT)` read
directly from SQL, exactly one `DEBIT` for the winning bet, `20.00` / `70.00` /
`50.00` final balances, and `POST /wallets/:id/reconciliation` (queried on yet
another instance) reporting `consistent: true`.

**Why this proves "correct with N instances":** the only thing serialising the
two concurrent debits is `SELECT … FOR UPDATE` on the `wallets` row. That lock
is held by a **PostgreSQL backend** and released on `COMMIT` — it does not know
or care which process, host or container opened the transaction. Three unrelated
OS processes hit the same row; Postgres orders them; the application holds no
in‑memory mutex, semaphore or leader that could be doing the work instead. If
correctness depended on single‑process state, this test would show a double
debit or a negative balance — it shows neither.

## 12. Roadmap (next slices)

1. **Load test** exposed as `bun run test:load`.
2. **OpenTelemetry** — spans around the use case, the UoW transaction and each
   SQS/outbox hop, exported via OTLP; the `correlationId` becomes the trace id.
3. A bundled Grafana dashboard for the `/metrics` series.
