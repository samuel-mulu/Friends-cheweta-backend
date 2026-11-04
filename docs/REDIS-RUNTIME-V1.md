# Redis Runtime V1

Redis holds ephemeral coordination state only. PostgreSQL is the source of truth for
matches, entries, wallet and settlement. Where both have an opinion (e.g. whether a
challenge produced a match), PostgreSQL wins.

Keys (all prefixed by `REDIS_KEY_PREFIX`):

```text
# Gameplay
runtime:ludo:{matchId}:snapshot            live game state (authoritative while playing)
runtime:ludo:{matchId}:command:{commandId} command idempotency
runtime:ludo:{matchId}:timing              turn deadline
runtime:ludo:{matchId}:joined-players      who has joined the match room
runtime:ludo:turn-deadlines                zset matchId -> deadline
runtime:ludo:disconnect-deadlines          zset userId -> grace deadline
runtime:ludo:post-commit-retry             set of matchIds whose Postgres follow-up failed
lock:ludo-match:{matchId}

# Presence
presence:user:{userId}:socket-seen         zset socketId -> last heartbeat (stale ids age out)
presence:user:{userId}:meta

# Lobby
lobby:user:{userId}                        { gameModeId, state ONLINE|READY|CHALLENGED }
lobby:{gameModeId}:online                  set
lobby:{gameModeId}:ready                   zset userId -> readyAt

# Challenges (lobby, rematch, invite)
challenge:{id}                             record; status changes only in Lua scripts
challenge:user:{userId}                    the user's one open challenge
challenge:expires                          zset id -> expiresAt (swept every second)
challenge:invite:{code}                    invite code -> challenge id
challenge:cmd:{userId}:{commandId}         command idempotency
```

## Failure rules

- Snapshot missing for a PLAYING/FINISHING/FINISHED match: restored from the
  PostgreSQL checkpoint with `SET NX` (never overwrites a newer snapshot).
- Postgres follow-up after a committed move fails: the move stands, the match is
  added to `post-commit-retry`, and maintenance re-applies checkpoint/status/settlement.
- A challenge stuck in ACCEPTING (process died): after 60s the sweep checks
  PostgreSQL; a match means ACCEPTED, no match means CANCELLED.
