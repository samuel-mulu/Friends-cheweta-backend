# Friends Game Hub Financial Lifecycle V1

## Before matchmaking

`availableBalance` must be at least the snapshotted `GameMode.stakeAmountMinor`.

This is only eligibility. The balance is rechecked when the pair is actually formed.

## Entry reservation

For a 10 ETB room with two players:

```text
Before
A available 100 ETB / locked 0
B available 100 ETB / locked 0

After entry reservation
A available 90 ETB / locked 10 ETB
B available 90 ETB / locked 10 ETB
```

The game cannot instantiate its runtime before `entrySecuredAt` exists.

## Pre-game cancellation

```text
A locked 10 -> available 10
B locked 10 -> available 10
MatchEntry -> REFUNDED
Match -> CANCELLED
```

## Settlement

Example with a 10% fee:

```text
pot      = 20 ETB
fee      = 2 ETB
payout   = 18 ETB
```

Each participant's 10 ETB locked entry is consumed. The winner receives 18 ETB available balance. The 2 ETB platform fee is recorded in `MatchSettlement`.

Money arithmetic uses minor units (`BIGINT`) throughout.
