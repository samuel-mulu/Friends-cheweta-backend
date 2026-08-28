# B0–B3 API Examples

## Register

```bash
curl -X POST http://localhost:5000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"fullName":"Test Player","phoneNumber":"0911123456","password":"StrongPass123!","deviceName":"Android"}'
```

## Login

```bash
curl -X POST http://localhost:5000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"phoneNumber":"0911123456","password":"StrongPass123!","deviceName":"Android"}'
```

## Me

```bash
curl http://localhost:5000/api/users/me \
  -H 'Authorization: Bearer ACCESS_TOKEN'
```

## Wallet

```bash
curl http://localhost:5000/api/wallet/me \
  -H 'Authorization: Bearer ACCESS_TOKEN'
```

## Wallet transactions

```bash
curl 'http://localhost:5000/api/wallet/transactions/me?limit=30' \
  -H 'Authorization: Bearer ACCESS_TOKEN'
```

## Refresh

```bash
curl -X POST http://localhost:5000/api/auth/refresh \
  -H 'Content-Type: application/json' \
  -d '{"refreshToken":"REFRESH_TOKEN"}'
```

---

# B4 — Payments

Amounts are minor-unit strings. `1000` means 10 ETB.

## Submit deposit

```http
POST /api/payments/deposits
Authorization: Bearer <access-token>
Content-Type: application/json

{
  "amountMinor": "10000",
  "channel": "CBE",
  "transactionReference": "FT-EXAMPLE-123",
  "idempotencyKey": "mobile-deposit-7b6471",
  "note": "Optional note"
}
```

## Submit withdrawal

```http
POST /api/payments/withdrawals
Authorization: Bearer <access-token>
Content-Type: application/json

{
  "amountMinor": "5000",
  "channel": "TELEBIRR",
  "destination": "251911123456",
  "idempotencyKey": "mobile-withdrawal-d3d72c"
}
```

## Admin approve deposit

```http
PATCH /api/admin/payments/deposits/<deposit-id>/approve
Authorization: Bearer <admin-access-token>
```

## Admin reject withdrawal

```http
PATCH /api/admin/payments/withdrawals/<withdrawal-id>/reject
Authorization: Bearer <admin-access-token>
Content-Type: application/json

{
  "reason": "Destination could not be verified"
}
```

---

# B5 — Gaming catalog

## List games

```http
GET /api/games
Authorization: Bearer <access-token>
```

## List Ludo modes

```http
GET /api/games/LUDO/modes
Authorization: Bearer <access-token>
```

## Create a mode as admin

```http
POST /api/admin/games/modes
Authorization: Bearer <admin-access-token>
Content-Type: application/json

{
  "gameCode": "LUDO",
  "code": "LUDO_1V1_100",
  "name": "Ludo 1v1 - 100 ETB",
  "playerCount": 2,
  "stakeAmountMinor": "10000",
  "platformFeeBps": 1000,
  "turnDurationSeconds": 30,
  "rulesVersion": "LUDO_CLASSIC_V1",
  "enabled": true
}
```

## B14 reconnect snapshot

Socket `match:join` / `ludo:sync` now acknowledges both game state and the server deadline:

```json
{
  "ok": true,
  "state": { "game": { "version": 12, "turnPhase": "WAITING_FOR_ROLL" } },
  "timing": {
    "matchId": "match-id",
    "version": 12,
    "playerId": "user-id",
    "turnPhase": "WAITING_FOR_ROLL",
    "turnEndsAt": "2026-08-24T08:40:30.000Z",
    "consecutiveTimeoutsByPlayer": {}
  },
  "version": 12
}
```

The timestamp is authoritative. The client renders it and does not send a `timeout` command.

## B15 entry escrow

Matchmaking now reserves both players' stakes before returning `MATCHED`. There is no player-facing endpoint that can directly lock arbitrary wallet funds.

## B16 settlement

Settlement is server-triggered from the authoritative final Ludo runtime. There is no player-facing `payWinner` endpoint.

---

# B17-B20 additions

## Match history

```http
GET /api/matches/me?limit=20
Authorization: Bearer <access-token>
```

```http
GET /api/matches/<matchId>
Authorization: Bearer <access-token>
```

```http
GET /api/matches/<matchId>/replay
Authorization: Bearer <access-token>
```

Players can only access matches they participated in. Admins can inspect all matches.

## Notifications

```http
GET /api/notifications?limit=30&unreadOnly=true
Authorization: Bearer <access-token>
```

```http
PATCH /api/notifications/<notificationId>/read
Authorization: Bearer <access-token>
```

```http
PATCH /api/notifications/read-all
Authorization: Bearer <access-token>
```

## Admin operations

```http
GET /api/admin/dashboard
Authorization: Bearer <admin-access-token>
```

```http
GET /api/admin/matches?status=FINISHED&limit=50
Authorization: Bearer <admin-access-token>
```

```http
GET /api/admin/matches/<matchId>/replay
Authorization: Bearer <admin-access-token>
```

```http
GET /api/admin/risk-flags?status=OPEN
Authorization: Bearer <admin-access-token>
```

```http
PATCH /api/admin/risk-flags/<riskFlagId>
Authorization: Bearer <admin-access-token>
Content-Type: application/json

{
  "status": "REVIEWED"
}
```

```http
GET /api/admin/audit?limit=100
Authorization: Bearer <admin-access-token>
```
