# ADR-005 — Redis for Runtime State Only

## Decision
Redis will be introduced in the realtime phases for active match state, matchmaking, presence, command deduplication, timers, short-lived locks, and Socket.IO scaling.

## Not allowed
Redis is not the durable wallet, ledger, settlement, payment, or audit database.
