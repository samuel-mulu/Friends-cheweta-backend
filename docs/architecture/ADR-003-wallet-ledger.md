# ADR-003 — Wallet + Immutable Ledger

## Decision
Every wallet mutation is atomic, idempotent, and accompanied by a WalletTransaction record.

Money is stored in integer minor units using PostgreSQL BIGINT / Prisma BigInt.

## Invariants
- availableBalance >= 0
- lockedBalance >= 0
- one wallet per user
- one idempotency key can affect money at most once
- successful balance changes and ledger creation commit together
- players never receive generic credit/debit endpoints
