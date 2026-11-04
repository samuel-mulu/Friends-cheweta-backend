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

## Lobby, challenges, rematch, invite

All commands carry a client `commandId` (UUID) and are idempotent per user. Acks are
`{ ok: true, data? }` or `{ ok: false, code, message }`. Server events use the envelope above.

| Client → server | Payload | Ack `data` |
|---|---|---|
| `lobby:join` | `gameModeId` | snapshot, or `{ activeMatch }` if the player has a live match |
| `lobby:ready` / `lobby:unready` / `lobby:leave` | – | – |
| `challenge:create` | `opponentUserId` | – |
| `challenge:accept` / `reject` / `cancel` | `challengeId` | accept: challenge incl. `match` |
| `challenge:rematch` | `matchId` (finished, ≤10 min ago) | challenge (`kind: REMATCH`) |
| `challenge:invite_create` | `gameModeId` | challenge incl. `inviteCode` (10 chars, 10 min) |
| `challenge:invite_join` | `code` (case/dashes ignored) | challenge incl. `match` |
| `challenge:active` | – | the caller's open challenge or `null` (reconnect recovery) |
| `admin:join_operations` | – (ADMIN only) | – |

| Server → client | To | Meaning |
|---|---|---|
| `challenge:created` / `challenge:received` | challenger / opponent | pending challenge |
| `challenge:accepted` / `rejected` / `cancelled` / `expired` | both players | single final outcome |
| `match:ready` | each player | enter `data.match.id` (also in the accept/join ack) |
| `lobby:player_joined` / `player_ready` / `player_unready` / `player_available` / `player_busy` / `player_left` | lobby room | viewer-neutral player views (no `isSelf`) |
| `admin:match_event` | admin room | copy of every match event |

Rules: a user holds at most one open challenge. Once an accept has started
(`ACCEPTING`) it cannot be cancelled; it ends as ACCEPTED (a match exists) or CANCELLED.
Disconnecting cancels a PENDING challenge. Clients recover with `lobby:join` /
`challenge:active` / `match:join` + `ludo:sync`, not by replaying missed events.
