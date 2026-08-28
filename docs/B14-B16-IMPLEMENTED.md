# B14-B16 Implemented

## B14 - Reconnect + Authoritative Turn Timeout

The backend owns all deadlines. Flutter only renders `turnEndsAt` returned with `match:join` / `ludo:sync` snapshots.

Implemented:

- Redis-backed turn timing metadata and sorted-set deadline queue.
- Server-maintained `turnEndsAt` for pre-game rolls, `WAITING_FOR_ROLL`, and `WAITING_FOR_MOVE`.
- Reconnect snapshots include both authoritative runtime state and timing state.
- Version-gap recovery remains snapshot-only; normal play remains event-driven.
- Roll timeout: server executes the real `ROLL_DICE` runtime command.
- Move timeout: server picks the lexicographically first legal token, making timeout movement deterministic and replayable.
- Repeated timeout policy: each automatic timeout action increments a per-player counter. A manual command resets the player's counter. Default threshold is 3; reaching it executes authoritative `RESIGN`.
- Pre-game starting rolls are auto-rolled if players do not act, preventing a matched game from getting stuck before `PLAYING`.
- Multi-socket-aware disconnect grace. Default grace is 90 seconds.
- Paid matches do not begin pre-roll until every participant has joined the realtime room at least once.
- A default 180-second READY no-show window cancels and refunds a matched session that never gets all participants joined.
- If grace expires before game start, the match is cancelled and locked stakes are refunded.
- If grace expires during `PLAYING`, the disconnected player is authoritatively resigned.
- A 1-second maintenance loop processes Redis deadline queues. Match locks and command idempotency make multiple app instances safe from duplicate authoritative mutations.

Environment:

```env
LUDO_MAX_CONSECUTIVE_TIMEOUTS=3
LUDO_DISCONNECT_GRACE_SECONDS=90
```

### Timeout policy

The server does not trust the mobile countdown. The client receives a timestamp and displays:

```text
remaining = turnEndsAt - server-adjusted current time
```

When the deadline expires, the server decides what happens even if every client is disconnected.

## B15 - Game Entry / Escrow

A match is no longer playable merely because matchmaking found two users.

Flow:

```text
matchmaking pair
  -> create Match(CREATED)
  -> one SERIALIZABLE PostgreSQL transaction
       -> claim entry reservation
       -> lock Player A stake
       -> lock Player B stake
       -> create MatchEntry rows
       -> mark entrySecuredAt
       -> Match READY
  -> MATCHED notification
```

If either wallet cannot lock the full stake, the entire transaction rolls back. There is no one-player-paid / one-player-unpaid match.

New durable state:

- `Match.entrySecuredAt`
- `Match.cancelledAt`
- `Match.cancellationReason`
- `Match.winnerOrder` and `Match.resultVersion` for a durable final-result checkpoint before settlement
- `MatchEntry`
- `MatchEntryStatus = LOCKED | REFUNDED | SETTLED`

Runtime creation now hard-fails with `MATCH_ENTRY_NOT_SECURED` unless entry has been secured.

Cancellation before gameplay releases every `LOCKED` entry using idempotent wallet transactions, marks entries `REFUNDED`, and marks the match `CANCELLED` in the same database transaction.

## B16 - Exactly-once Settlement

When the pure runtime reaches `FINISHED`, the application marks the durable match `FINISHING` and attempts settlement.

Settlement transaction:

```text
verify final runtime result
verify entries are LOCKED
claim settleable Match
for each player:
  debit locked stake exactly once
calculate pot
calculate platform fee from snapshotted platformFeeBps
credit winner payout exactly once
persist result positions
mark MatchEntry rows SETTLED
create unique MatchSettlement(matchId)
mark Match FINISHED
COMMIT
```

New wallet transaction type:

- `GAME_ENTRY_SPEND`

New durable model:

- `MatchSettlement` with unique `matchId`
- winner
- pot amount
- platform fee amount
- payout amount
- final winner order

The platform fee is durably recorded as platform revenue in `MatchSettlement`; it is not represented as a player wallet balance.

### Exactly-once guarantees

Settlement is protected by:

- unique `MatchSettlement.matchId`
- idempotent wallet transaction keys
- guarded match status transition
- serializable DB transaction
- retry of `FINISHING` matches from the durable PostgreSQL winner-order checkpoint, so settlement does not depend on Redis surviving indefinitely

A transient settlement failure does not replay the Ludo move that ended the match. The game state remains final and the maintenance loop retries the financial settlement.

## Architecture rule retained from Friends Bingo lessons

Normal lifecycle stays:

```text
client command
-> authoritative runtime
-> persist runtime + command dedupe
-> durable lifecycle/settlement work
-> server event
```

No GET mutation, no Flutter-owned timeout transition, no repair scheduler inventing game state, and no canonical sync after every socket event.
