# Realtime Timeout and Reconnect V1

## Client contract

`match:join` and `ludo:sync` return:

```json
{
  "ok": true,
  "state": "<authoritative Ludo runtime snapshot>",
  "timing": {
    "matchId": "...",
    "version": 22,
    "playerId": "...",
    "turnPhase": "WAITING_FOR_MOVE",
    "turnEndsAt": "2026-08-24T08:30:30.000Z",
    "consecutiveTimeoutsByPlayer": {}
  },
  "version": 22
}
```

Flutter displays the timer but never decides expiry.

## Recovery

Normal path:

```text
command -> server event -> apply
```

Recovery path only:

```text
reconnect OR version gap -> ludo:sync -> replace with snapshot
```

Before `ROLL_FOR_START` is accepted, every participant must have joined the realtime match at least once. If that never happens within the READY no-show window, the backend cancels the match and refunds both entries.

## Timeout actions

- `START_ROLL`: missing candidates are server rolled.
- `WAITING_FOR_ROLL`: server executes `ROLL_DICE`.
- `WAITING_FOR_MOVE`: server executes `MOVE_TOKEN` using the sorted first legal token ID.
- configured repeated timeout threshold reached: server executes `RESIGN`.

## Disconnect

Presence is multi-socket aware. Losing one socket does not start grace if another socket for that user is still connected.

If the final socket disconnects, a grace deadline is stored in Redis.

Reconnect before deadline removes the deadline.

Expiry:

- `READY`: cancel match and refund entry.
- `PLAYING`: authoritative resign.
