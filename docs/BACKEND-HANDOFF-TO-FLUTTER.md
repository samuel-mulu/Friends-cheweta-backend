# Backend Handoff to Flutter

The backend feature contract is frozen enough to begin the Flutter player application.

## Flutter should integrate these HTTP areas

- `/api/auth/*`
- `/api/users/me`
- `/api/wallet/*`
- `/api/payments/*`
- `/api/games/*`
- `/api/matches/*`
- `/api/notifications/*`

## Flutter realtime namespace

- namespace: `/game`
- authenticate with access JWT
- send commands only; never calculate authoritative game outcomes
- join user/match rooms through the server
- use command acknowledgements for request success/failure
- use event `version` for gap detection
- call `ludo:sync` only for reconnect/version-gap recovery
- render `turnEndsAt`; never decide turn expiry locally

## Client trust boundary

Flutter may animate or optimistically highlight legal choices, but the backend remains authoritative for:

- dice
- legal moves
- token destination
- capture/blockade resolution
- current turn
- timeout
- winner
- wallet
- entry/escrow
- settlement

## Recommended next work

Start Flutter with foundation/auth/wallet/lobby first. Add the Ludo board only after the socket client and state store can consume authoritative snapshots and versioned events cleanly.
