# Friends Game Hub Backend - B0 to B20

Production-minded **modular monolith** for Friends Game Hub. Ludo is the first game. The backend is intentionally designed so future games can reuse identity, wallet, payments, matchmaking/entry concepts, notifications, audit and administration without forcing Keno/Aviator-style games into the Ludo engine.

## Stack

- NestJS + TypeScript
- Prisma 7 + PostgreSQL 16
- Redis 7
- Socket.IO + Redis adapter
- JWT authentication
- Docker Compose

## Implemented

### B0-B6 - Platform and Ludo domain
Architecture freeze, auth/users, wallet/ledger, deposits/withdrawals, gaming catalog/modes, and frozen `LUDO_CLASSIC_V1`.

### B7-B10 - Ludo engine and proof
Pure engine, legal moves, capture/safe/blockade/home rules, secure/testable dice providers, one authoritative match runtime, version/idempotency rules, bots, simulation and deterministic replay testing.

### B11-B13 - Realtime, Redis and matchmaking
Socket.IO protocol, JWT socket authentication, user/match rooms, authoritative event envelopes, Redis snapshots/dedupe/locks/presence/adapter, and simple Ludo 1v1 FIFO matchmaking by game mode.

### B14-B16 - Reconnect, escrow and settlement
Server-owned turn deadlines, reconnect recovery, deterministic timeout handling, disconnect grace, atomic two-player stake reservation, cancellation refunds and exactly-once settlement.

### B17 - Match History / Replay
Durable `MatchEvent` and `MatchCheckpoint`, player match history, admin match inspection and Redis runtime recovery from PostgreSQL checkpoint.

### B18 - Notifications
Persistent notification inbox with dedupe, unread count and read state. Match-result and payment-review notifications are integrated. Push delivery is intentionally deferred.

### B19 - Admin Backend
Dashboard, users, payment operations, games/modes, matches/replay, settlement visibility, risk review and audit logs.

### B20 - Risk / Anti-Cheat Baseline
Server authority remains the main anti-cheat boundary. Added explainable risk flags for repeated-opponent and repeated-timeout patterns. No ML and no automatic punishment.

## Core architecture

```text
Flutter
  | REST + Socket.IO commands
  v
NestJS modular monolith
  |-- Auth / Users
  |-- Wallet / Ledger / Payments
  |-- Gaming / Matchmaking / Entry / Settlement
  |-- Ludo pure engine + authoritative runtime
  |-- Match History / Notifications / Risk / Audit / Admin
  |
  |-- PostgreSQL = durable + financial truth
  `-- Redis      = hot runtime / presence / queues / locks / fan-out
```

## Non-negotiable rules

- clients send intent, backend owns truth
- GET endpoints do not mutate lifecycle
- one Ludo runtime owns gameplay transitions
- every money mutation is transactional and ledger-backed
- critical commands are idempotent
- match state versions only move forward
- socket events are facts emitted after authoritative mutation
- Redis is never the financial ledger
- recovery sync is exceptional, not normal gameplay flow

## Start locally

```bash
cp .env.example .env
docker compose up -d
npm install
npm run prisma:generate
npm run prisma:deploy
npm run seed
npm run build
npm test
npm run start:dev
```

HTTP API:

```text
http://localhost:5000/api
```

Socket.IO namespace:

```text
/game
```

## Ludo QA

```bash
npm test
npm run simulate:ludo -- 5000
npm run fuzz:ludo -- 1000
```

## Documentation

Start with:

- `docs/LUDO_CLASSIC_V1.md`
- `docs/REALTIME-PROTOCOL-V1.md`
- `docs/REDIS-RUNTIME-V1.md`
- `docs/MATCHMAKING-V1.md`
- `docs/REALTIME-TIMEOUT-V1.md`
- `docs/FINANCIAL-LIFECYCLE-V1.md`
- `docs/B17-B20-IMPLEMENTED.md`
- `docs/BACKEND-HANDOFF-TO-FLUTTER.md`

## Current milestone decision

**The backend feature core is complete enough to begin Flutter integration.** Do not add more backend abstractions before the mobile client proves the real API/socket contract.

Production-only hardening such as VPS deployment, backups, load tests, metrics/alerts and final security review remains necessary before public paid launch, but it should be done after the Flutter integration exposes real usage patterns.
