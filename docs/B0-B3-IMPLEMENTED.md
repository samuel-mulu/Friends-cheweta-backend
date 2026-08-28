# B0–B3 Implementation Checkpoint

## B0 — Architecture Freeze

Implemented decisions:
- Modular monolith.
- Backend is authoritative for future games.
- PostgreSQL is durable truth.
- Redis is deferred to runtime/realtime phases and may not own financial truth.
- Wallet changes are ledger-backed, transactional, and idempotent.
- GET endpoints are read-only.
- No Ludo code is included yet.

## B1 — Project Foundation

Implemented:
- NestJS project layout.
- Prisma ORM 7 configuration using `prisma.config.ts`.
- PostgreSQL adapter.
- Initial migration.
- Docker Compose PostgreSQL.
- Environment validation.
- Global DTO validation.
- Error envelope.
- Request IDs and structured request logging.
- Health endpoint.

## B2 — Authentication & Users

Implemented:
- PLAYER and ADMIN.
- ACTIVE and BLOCKED.
- Ethiopian phone normalization.
- Registration.
- User + Wallet atomic creation.
- Password hashing.
- Login.
- Access JWT.
- Refresh session storage with token hashes.
- Refresh rotation with replay protection.
- Logout/revocation.
- `/users/me`.
- Admin list/detail/status APIs.

## B3 — Wallet & Ledger

Implemented:
- ETB minor-unit BigInt storage.
- available + locked balances.
- Immutable ledger transactions.
- DB non-negative balance constraints.
- Atomic balance update + ledger creation.
- Idempotency key uniqueness.
- Credit available.
- Debit available.
- Lock funds.
- Release funds.
- Debit locked funds.
- Read-only player wallet endpoint.
- Cursor-based ledger history.

## Explicitly Not Implemented Yet

- B4 Deposits & Withdrawals.
- B5 Gaming Platform Core.
- Ludo domain.
- Redis.
- Socket.IO.
- Matchmaking.
- Escrow orchestration.
- Game settlement.

Those should be added phase-by-phase instead of mixed into this foundation.
