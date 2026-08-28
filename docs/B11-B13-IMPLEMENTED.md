# B11-B13 Implemented

## B11 - Realtime Protocol

Implemented a Socket.IO gateway on `/game` with server-authoritative commands and events.

### Authentication

Clients authenticate during the Socket.IO handshake using either:

- `auth.token = <access JWT>`
- `Authorization: Bearer <access JWT>`

The backend verifies the JWT again against the current user record. Blocked users are rejected even if they still possess an unexpired token.

### Rooms

- Personal room: `user:{userId}`
- Match room: `match:{matchId}`

Every authenticated socket automatically joins its user room. A socket joins a match room only after `match:join` verifies that the user is a participant.

### Commands

Client commands are requests for intent only:

- `match:join`
- `ludo:sync`
- `ludo:roll_for_start`
- `ludo:roll`
- `ludo:move`
- `ludo:resign`
- `matchmaking:join`
- `matchmaking:cancel`
- `matchmaking:status`

The client never supplies dice values, positions, captures, winners, or match results.

### Server events

The server publishes facts such as:

- `ludo:starting_roll`
- `ludo:starting_roll_tie`
- `match:started`
- `ludo:turn_started`
- `ludo:dice_rolled`
- `ludo:legal_moves_ready`
- `ludo:no_legal_move`
- `ludo:third_six_forfeited`
- `ludo:token_moved`
- `ludo:token_captured`
- `ludo:token_finished`
- `ludo:extra_roll_granted`
- `ludo:player_finished`
- `ludo:player_resigned`
- `match:finished`
- `matchmaking:matched`

Every authoritative match event is wrapped in a versioned envelope containing protocol version, event ID, server time, match ID, and match version.

### Acknowledgements

Game commands return a compact acknowledgement:

```json
{
  "ok": true,
  "commandId": "cmd-12345678",
  "version": 18,
  "duplicate": false
}
```

A duplicate command is not executed again and its server events are not re-broadcast. If the client missed events it must use `ludo:sync` as a recovery path.

## B12 - Redis Runtime Layer

Redis now owns hot operational game state while PostgreSQL remains the durable business/financial database.

### Redis responsibilities

- Active Ludo snapshots
- App-restart recovery of active match state
- Command ID deduplication
- Distributed per-match command lock
- Presence
- Socket.IO multi-instance adapter
- Matchmaking queues
- Queue assignments

### Runtime command flow

```text
Socket command
  -> participant check
  -> distributed match lock
  -> Redis command-id lookup
  -> load Redis snapshot
  -> restore pure B9 runtime
  -> execute command
  -> atomically write new snapshot + command record to Redis
  -> release lock
  -> emit authoritative server events
```

The match lock protects one short game transition. No external APIs or long-running work should run while this lock is held.

### Command dedupe

B9's in-memory command cache is no longer relied on at the network boundary. B12 stores a Redis command record containing the command fingerprint and resulting version. Snapshot and command record are written in the same Redis `MULTI/EXEC` transaction.

If the same `commandId` is retried with the same payload, it returns as a duplicate. If the same ID is reused for different command data, the command fails with `COMMAND_ID_REUSE`.

### Recovery behavior

A NestJS process restart can restore a Ludo runtime from its Redis snapshot.

The server deliberately **does not recreate an already PLAYING/FINISHING match from an empty initial state** if its Redis snapshot is missing. It fails closed with `LUDO_RUNTIME_SNAPSHOT_MISSING`. Durable replay after Redis data loss belongs to the later MatchEvent/history phase.

### Redis persistence

Development Docker Redis runs with AOF enabled using `appendfsync everysec`. This improves restart persistence, but Redis is still not the financial source of truth. Wallets, deposits, withdrawals, and later settlements remain PostgreSQL transactions.

### TTL defaults

- Active runtime snapshot: 24 hours, refreshed on use
- Command dedupe: 24 hours
- Presence: 90 seconds, refreshed every 30 seconds
- Matchmaking ticket: 10 minutes
- Match lock: 5 seconds

All values are environment configurable.

## B13 - Matchmaking

B13 intentionally implements only Ludo 1v1 queues.

### Queue partitioning

Each enabled Ludo 1v1 `GameMode` has an independent FIFO Redis sorted-set queue. Because game mode already contains stake amount, rules version, and turn duration, players only match with the same mode/stake configuration.

### Duplicate protection

A global `matchmaking:user:{userId}` key prevents one user from entering multiple queues simultaneously.

### Wallet eligibility

Before entering the queue and again before pairing, the backend verifies:

- User is ACTIVE
- Game is enabled
- Mode is enabled
- Mode is Ludo 1v1
- Wallet exists
- `availableBalance >= stakeAmountMinor`

B13 performs eligibility only. It does **not** reserve the stake. B15 will atomically move available funds into locked/escrow balance before a paid match is allowed to begin.

### Idempotent match creation

Each queue entry gets a unique ticket ID. A deterministic `matchmakingKey` is derived from the mode and the two ticket IDs and stored uniquely in PostgreSQL `Match.matchmakingKey`.

This protects the DB boundary from duplicate match creation if a process fails after match creation but before Redis queue cleanup.

### Lost MATCH_FOUND protection

After a match is created, Redis stores a short-lived assignment for both users. If a socket disconnects before receiving `matchmaking:matched`, `matchmaking:status` can return the same match assignment after reconnect.

### Intentional limitations until later phases

- No skill/rank matchmaking
- No 4-player queues
- No paid stake lock yet (B15)
- No turn timeout/reconnect policy yet (B14)
- No durable PostgreSQL match-event replay yet (later history/replay phase)
