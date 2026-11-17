# Data model

PostgreSQL holds everything that must survive: accounts, money, and the record of each match. Redis holds what is live and can be rebuilt: the running match state, turn clocks, presence, lobbies and challenges (see `REDIS-RUNTIME-V1.md`). The schema is `prisma/schema.prisma`.

All money is `BigInt` in minor units (santim). Nothing is stored as a float.

## Tables and who writes them

Each table has one owning service. Other code reads it but does not write it.

| Table | What it holds | Written by |
|---|---|---|
| `User`, `UserSession` | Account, role, status; refresh-token sessions | `auth`, `users` |
| `Wallet` | `availableBalance` and `lockedBalance` per user | `wallet/wallet.service.ts` only |
| `WalletTransaction` | Ledger: one row per balance change, with balances before and after | `wallet/wallet.service.ts` only |
| `Deposit`, `Withdrawal` | Payment requests and their admin review | `payments/payments.service.ts` |
| `Game`, `GameMode` | Catalog: games, stakes, fee, turn time, rules version | seed (`seed/catalog-seed.ts`), `gaming` admin |
| `Match` | One game between players: status, stake, source, result | see "Match lifecycle" below |
| `MatchParticipant` | Who sits where; final position | created with the match; `resultPosition` by `settlement` |
| `MatchEntry` | Each player's locked stake | `match-creation` (lock), `game-entry` (refund), `settlement` (settle) |
| `MatchSettlement` | Pot, platform fee, payout, winner (null for a draw) | `settlement/settlement.service.ts` |
| `MatchCheckpoint` | Latest full game state, one row per match | `match-history` (called by the runtime after each command) |
| `MatchEvent` | Move-by-move events for replay and disputes | `match-history`; pruned after retention |
| `PlayerMatchStat` | Per-player result of a finished paid match | `stats/stats.service.ts`, once after settlement |
| `RiskFlag` | Suspicious patterns for admin review | `risk/risk.service.ts` |
| `Notification`, `DirectMessage` | In-app notifications; private chat | `notifications`, `chat` |
| `AuditLog` | Admin actions | `audit/audit.service.ts` |

## Relations

```
User 1─1 Wallet 1─n WalletTransaction
User 1─n Deposit / Withdrawal
Game 1─n GameMode 1─n Match
Match 1─n MatchParticipant n─1 User
Match 1─n MatchEntry       n─1 User
Match 1─1 MatchSettlement
Match 1─1 MatchCheckpoint
Match 1─n MatchEvent
Match 1─n PlayerMatchStat  n─1 User
```

Rows that carry money or results use `onDelete: Restrict`: a user with a wallet or a match cannot be deleted.

## Match lifecycle

| Status | Meaning | Set by |
|---|---|---|
| `CREATED`, `WAITING` | Being assembled; stakes not all locked | `match-creation` |
| `READY` | Stakes locked (`entrySecuredAt` set); waiting for players to open it | `match-creation`, `practice` |
| `PLAYING` | First real command was played | `TurnGameRuntime.syncMatchStatus` |
| `FINISHING` | Game over; `winnerOrder` / `isDraw` recorded; settlement pending | `TurnGameRuntime.syncMatchStatus` |
| `FINISHED` | Settled and paid | `settlement` |
| `CANCELLED` | Never started; stakes refunded | `game-entry.cancelAndRefund` |

`Match.source` (`MatchSource`): `CHALLENGE`, `REMATCH`, `INVITE` are paid; `PRACTICE` is free play against a bot and is excluded from stats, leaderboard, rematch and risk checks.

`Match.rulesVersion` stays a string because versions are defined in code (`LUDO_CLASSIC_V3`, `DAMA_ET_V1`, …). A match keeps the version it started with.

## Invariants

- **Balances never go negative.** Wallet updates are conditional (`WHERE availableBalance >= amount`) inside a transaction, and a database `CHECK` backs this up.
- **Every balance change has a ledger row** written in the same transaction, with `balanceBefore` / `balanceAfter`.
- **Money operations are idempotent.** `WalletTransaction`, `Deposit` and `Withdrawal` have unique idempotency keys; a repeated request returns the first result.
- **One settlement per match** (`MatchSettlement.matchId` is unique). A match stuck in `FINISHING` is retried by the reconciler every 5 seconds.
- **The checkpoint only moves forward.** `MatchCheckpoint.version` is never replaced by a lower one, even with concurrent writers.
- **Event order is fixed by the game.** `MatchEvent.sequence = version × 1000 + index`, unique per match, so late writes cannot reorder history.
- **A result is written in one place.** `Match.winnerOrder` and `MatchParticipant.resultPosition` are both set by `settlement` in the same transaction. `winnerOrder` is the ordered result; `resultPosition` exists so "my matches" can be queried per user.
- **Redis is the live truth, PostgreSQL the durable copy.** A command is committed to Redis first and answered; the checkpoint and events follow in order per match. If that write fails the match is queued for retry, and if Redis loses a live match it is restored from the checkpoint.

## Retention

`MatchEvent` rows are deleted once a match is closed (`FINISHED`, `CANCELLED`, `ABORTED`) and old: 30 days for paid matches, 1 day for practice (`MatchHistoryService.pruneEvents`, run hourly). The match, its result, settlement and final checkpoint are kept. Replay of an older match returns the final state without the move list.

Nothing else is deleted automatically.

## Indexes worth knowing

| Index | Serves |
|---|---|
| `Match(status, updatedAt)` | Settlement reconciler; event pruning |
| `Match(status, entrySecuredAt)` | Ready no-show sweep |
| `Match(status, createdAt)` | Abandoned pre-match sweep |
| `Match(gameModeId, status, createdAt)` | Lobby and admin lists |
| `MatchEvent(matchId, sequence)` unique | Replay in order; idempotent event writes |
| `WalletTransaction(walletId, createdAt)` | Wallet history |
| `RiskFlag(status, severity, createdAt)` | Admin risk queue, worst first |
