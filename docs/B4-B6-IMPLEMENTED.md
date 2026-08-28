# B4–B6 Implementation Notes

## B4 — Deposits & Withdrawals

### Deposit lifecycle

```text
PLAYER SUBMITS
    ↓
PENDING
    ├── ADMIN APPROVE → wallet credit + APPROVED in one DB transaction
    └── ADMIN REJECT  → REJECTED, no wallet mutation
```

A `transactionReference` is globally unique so the same receipt/reference cannot be submitted twice. The client request also carries a unique `idempotencyKey`.

### Withdrawal lifecycle

```text
PLAYER SUBMITS
    ↓
create PENDING withdrawal
+ atomically lock wallet funds
    ↓
ADMIN
    ├── APPROVE → debit locked funds + APPROVED
    └── REJECT  → release locked funds + REJECTED
```

This prevents double-spending between a pending withdrawal and a future game entry.

### Financial invariant

Payment state and its corresponding wallet mutation are committed together where money changes. Socket.IO/notifications are not involved yet and will never be part of the DB transaction.

## B5 — Gaming Platform Core

Shared durable models:

```text
Game
GameMode
Match
MatchParticipant
```

`GameMode` is commercial/runtime configuration. A `Match` copies the values that must remain historical:

```text
rulesVersion
stakeAmountMinor
platformFeeBps
```

Changing a mode tomorrow therefore does not rewrite yesterday's match terms.

The initial seed creates:

```text
LUDO
LUDO_1V1_10
LUDO_1V1_20
LUDO_1V1_50
```

No public match-creation endpoint exists yet. `GamingService.createMatch()` is an internal application primitive intended for the future matchmaking phase.

## B6 — Ludo Rules & Domain Model

The Ludo domain is pure TypeScript. It imports no NestJS, Prisma, PostgreSQL, Redis or Socket.IO code.

B6 includes:

```text
Ludo rules constant
board mapping
safe-square map
player/token state types
initial-state factory
state invariant validator
unit tests
```

The actual legal-move/capture/turn/winner engine begins in B7.

See `docs/LUDO_CLASSIC_V1.md` for the frozen rule contract and explicit Friends Game Hub decisions made where the supplied source material was ambiguous.
