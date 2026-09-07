# Architecture & Decisions

> Status. Implemented end‑to‑end: wallet creation (`OPENING`), `BET` / `WIN` /
> `LOSS`, `REFUND` / `ROLLBACK` (with reference resolution), the
> `PENDING_REFERENCE` worker (out‑of‑order references), the **SQS consumer**
> (persistent inbox, ack‑after‑commit, DLQ), pessimistic hot‑wallet concurrency,
> persistent idempotency, transactional outbox + relay, ledger, reconciliation,
> health checks. **Not yet wired**: metrics / structured‑log formatter, load
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

If the reference is not found, the transaction is persisted as
`PENDING_REFERENCE` (HTTP `202`) with `WagerTransactionPendingReference` emitted.
`PendingReferenceWorker` scans
`status='PENDING_REFERENCE' AND next_attempt_at <= now()` (partial index),
`LIMIT n`, and re‑runs `ResolvePendingReferenceUseCase` per row **under the
wallet lock** — a stale pick is a no‑op, so it is multi‑instance safe.

`ReferenceResolutionPolicy`: first retry immediate, then exponential backoff from
`baseDelayMs` (2s) capped at `capDelayMs` (5min), up to `maxAttempts` (10).
Budget exhausted → `REJECTED / REFERENCE_NOT_FOUND` + `WagerTransactionRejected`.
Rationale: ~10 attempts over roughly 40 min tolerates realistic out‑of‑order
windows without parking rows forever.

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
  `validateReversal` rules; currency conflict; idempotency‑key/payload divergence.
- **Integration** (`test/integration`, real PostgreSQL + real LocalStack SQS):
  outbox atomicity, relay publish‑once, crash‑pending rows, rejection emits no
  ledger entry; `REFUND`/`ROLLBACK` happy paths, reverse‑once rejection,
  amount‑mismatch, overdraw, and out‑of‑order `PENDING_REFERENCE` → worker
  resolves / exhausts the budget; **SQS consumer** — happy path + ack, redelivery
  dedup, crash‑after‑commit replay, business rejection → ack, malformed / unknown
  wallet / `OPENING` → DLQ with a reason.
- **Concurrency** (`test/concurrency`, real parallelism via `Promise.all`
  against a live HTTP server): the §8 scenario, 50× duplicate, idempotency
  conflict.

`wallet.balance == balance rebuilt from the ledger` is asserted through
`POST /wallets/:id/reconciliation` in the concurrency tests.

## 12. Roadmap (next slices)

1. **Metrics + JSON logs**: Prometheus counters (transactions by status,
   duplicates, retries, DLQ depth, lock waits, outbox lag), a global JSON log
   formatter (context — `correlationId`, `messageId`, `transactionId`,
   `walletId`, `providerId` — is already threaded through).
2. **Load test** exposed as `bun run test:load`.
3. Multi‑instance test harness (spawn 3 `bun run src/main.ts` / `bun run worker`
   against one DB) — correctness already holds because the lock is in PG.
