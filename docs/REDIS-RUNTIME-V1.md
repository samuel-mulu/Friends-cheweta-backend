# Redis Runtime V1

Redis is an operational runtime store, not the wallet or settlement database.

Representative keys (all prefixed by `REDIS_KEY_PREFIX`):

```text
runtime:ludo:{matchId}:snapshot
runtime:ludo:{matchId}:command:{commandId}
lock:ludo-match:{matchId}
presence:user:{userId}:sockets
presence:user:{userId}:meta
matchmaking:queue:{gameModeId}
matchmaking:ticket:{ticketId}
matchmaking:user:{userId}
matchmaking:assignment:{userId}
lock:matchmaking:{gameModeId}
```

## Failure rule

If the application restarts but Redis remains available, the match resumes from the snapshot.

If Redis has lost an active PLAYING snapshot, the backend fails closed instead of resetting the board. Durable reconstruction from PostgreSQL match events is intentionally deferred until the history/replay phase.
