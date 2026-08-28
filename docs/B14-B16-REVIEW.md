# B14-B16 Review Checklist

Implemented safety properties:

- The client never decides a timeout.
- Duplicate client commands do not extend the authoritative deadline.
- Automatic timeout actions use the same B9 runtime commands as human actions.
- The timeout worker does not mutate Ludo board state directly.
- A player with another active socket is not considered disconnected.
- Partial realtime join cannot start paid pre-roll.
- Matchmaking is not considered successful until both stakes are locked.
- If either stake lock fails, the database transaction rolls back both.
- A live runtime cannot be created without `entrySecuredAt`.
- Pre-game cancellation returns all still-locked entries exactly once.
- Final winner order is checkpointed in PostgreSQL before settlement retry logic.
- Each locked stake is consumed once.
- Winner payout is credited once.
- `MatchSettlement.matchId` is unique.
- FINISHING settlement retries do not replay the Ludo command that ended the game.
- Platform fee is calculated from the match's snapshotted `platformFeeBps`, not mutable current mode configuration.

Still intentionally deferred:

- B17 durable per-move `MatchEvent` / replay history.
- B18 notifications/push delivery.
- B19 broader admin match operations.
- Production monitoring/metrics and large-scale load tests.
