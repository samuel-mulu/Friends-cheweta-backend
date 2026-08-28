# Matchmaking V1

Scope: Ludo 1v1 only.

## Join

`matchmaking:join`

```json
{ "gameModeId": "..." }
```

Possible acknowledgement:

```json
{
  "ok": true,
  "status": "QUEUED",
  "ticketId": "...",
  "gameModeId": "..."
}
```

or a `MATCHED` result.

## Match found

Both players receive `matchmaking:matched` in their private `user:{userId}` rooms.

The client should then call `match:join` with the returned match ID.

## Cancel

`matchmaking:cancel`

Cancellation is idempotent. Calling it while not queued still returns success.

## Status/recovery

`matchmaking:status`

Returns `IDLE`, `QUEUED`, or a short-lived `MATCHED` assignment. The assignment exists so a user can recover a match-found result after a temporary socket disconnect.

## Financial boundary

Queue eligibility checks wallet balance but does not reserve it. Paid match reservation/escrow is a B15 responsibility and must be complete before real-money gameplay is enabled.
