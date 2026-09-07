# Architecture & Decisions

> Status: **MVP vertical slice**. Implemented end‑to‑end: wallet creation
> (`OPENING`), `BET` / `WIN` / `LOSS` over HTTP, pessimistic hot‑wallet
> concurrency, persistent idempotency, transactional outbox + relay, ledger,
> reconciliation, health checks. **Not yet implemented** (documented design
> below, extension points in place): SQS consumer wiring, `REFUND` / `ROLLBACK`,
> the `PENDING_REFERENCE` worker, DLQ handling, metrics. See *Roadmap*.

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
`WagerTransactionRejected`, `WalletBalanceChanged` (only when the balance moved).
`WagerTransactionPendingReference` is defined, emitted once §7.1 lands.

Envelope: `IntegrationEvent<T>` is an **abstract class**; `eventType` and
`version` live on the concrete subclass, not at the call site. `data` always
carries `MoneyProps` (decimal strings), never a `Money` instance.

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

## 10. Observability (partial)

Structured context (`correlationId`, `causationId`) flows through use cases and
onto every event envelope. `X-Correlation-Id` is honoured on inbound HTTP.
Health: `/health/live` (process), `/health/ready` (PostgreSQL `SELECT 1` + SQS
`GetQueueAttributes`). **TODO**: JSON log formatter wired globally, Prometheus
metrics (transactions by status, duplicates, retries, DLQ depth, lock waits,
outbox lag).

## 11. Testing

- **Unit** (`bun test src`, no I/O): `Money` scale/rounding/invalid input;
  `Wallet` invariants; `WagerTransaction` transitions + `ledgerDirectionFor`;
  currency conflict; idempotency‑key/payload divergence.
- **Integration** (`test/integration`, real PostgreSQL + real LocalStack SQS):
  outbox atomicity, relay publish‑once, crash‑pending rows, rejection emits no
  ledger entry.
- **Concurrency** (`test/concurrency`, real parallelism via `Promise.all`
  against a live HTTP server): the §8 scenario, 50× duplicate, idempotency
  conflict.

`wallet.balance == balance rebuilt from the ledger` is asserted through
`POST /wallets/:id/reconciliation` in the concurrency tests.

## 12. Roadmap (next slices)

1. **SQS consumer**: `@aws-sdk/client-sqs` long‑poll loop → `claimInbox`
   (`inbox_messages` PK `(consumer_name, message_id)`) → **same
   `SubmitWagerTransactionUseCase`** → ack only after commit; business error →
   ack, transient → visibility timeout, permanent → DLQ after `maxReceiveCount`.
2. **`REFUND` / `ROLLBACK`**: reference resolution by
   `(providerId, referenceExternalTransactionId)`, same
   provider/player/wallet/currency/round check, amount‑equality check, the
   partial unique index already blocks double reversal.
3. **`PENDING_REFERENCE` worker**: scheduled scan
   (`WHERE status='PENDING_REFERENCE' AND next_attempt_at <= now()`),
   exponential backoff, TTL → `REJECTED / REFERENCE_NOT_FOUND` + event.
4. **Metrics + JSON logs**, load test (`bun run test:load`).
5. Multi‑instance test harness (spawn 3 `bun run src/main.ts` on different
   ports against one DB) — correctness already holds because the lock is in PG.
