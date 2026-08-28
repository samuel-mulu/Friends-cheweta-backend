# Realtime Protocol V1

Namespace: `/game`

Transport: WebSocket only.

## Connect

```ts
io(`${API_URL}/game`, {
  transports: ['websocket'],
  auth: { token: accessToken },
});
```

On success the server emits `session:ready`.

## Match join

Client:

```json
{
  "event": "match:join",
  "payload": { "matchId": "..." }
}
```

Acknowledgement returns the authoritative runtime snapshot and its version. This is the normal way to enter the room and the recovery path after reconnect.

## Starting roll

```json
{
  "matchId": "...",
  "commandId": "uuid-or-client-unique-id",
  "expectedVersion": 0
}
```

Event: `ludo:roll_for_start`

## Normal roll

Event: `ludo:roll`

Payload uses `matchId`, `commandId`, and `expectedVersion`. The client never sends a dice value.

## Move

Event: `ludo:move`

```json
{
  "matchId": "...",
  "commandId": "...",
  "expectedVersion": 12,
  "tokenId": "RED-2"
}
```

The server checks that the token is in the authoritative legal-token list.

## Resign

Event: `ludo:resign`

Payload uses the standard command fields.

## Sync

Event: `ludo:sync`

```json
{ "matchId": "..." }
```

Use sync after reconnect or a detected version gap. Do not call it after every normal socket event.

## Event envelope

```json
{
  "protocolVersion": 1,
  "eventId": "...",
  "serverTime": "2026-08-24T07:00:00.000Z",
  "matchId": "...",
  "version": 13,
  "data": {}
}
```

Clients apply sequential versions. If the current local version is 10 and an event arrives with version 13, request `ludo:sync` rather than inventing missing state.

## Room rules

The backend is authoritative about room membership. A user can join `match:{matchId}` only if PostgreSQL confirms they are a participant. User rooms are server-assigned after JWT authentication.
