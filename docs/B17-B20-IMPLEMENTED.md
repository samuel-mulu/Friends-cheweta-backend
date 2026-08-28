# B17-B20 Implemented

This milestone completes the backend feature surface needed before starting the Flutter client. It deliberately avoids adding queues, analytics infrastructure, ML fraud systems, or a separate admin service.

## B17 - Match History and Replay

Durable PostgreSQL records were added for authoritative Ludo history:

- `MatchEvent` stores ordered domain events per match.
- `MatchCheckpoint` stores the latest authoritative runtime snapshot.
- Runtime execution persists the Redis result first, then writes durable history.
- If an active Redis snapshot is missing after a process/data failure, the runtime can restore from the PostgreSQL checkpoint instead of inventing a fresh board.
- Player endpoints expose only matches the authenticated player participated in.
- Admin endpoints can inspect any match and its replay/event stream.

Important boundary: this is not event-sourcing. Redis remains the hot match runtime and PostgreSQL keeps durable support/recovery history.

## B18 - Notifications

A small persistent notification inbox was added:

- match result notification after successful settlement
- deposit/withdrawal review notifications
- unread count
- mark one read
- mark all read
- `dedupeKey` prevents duplicate notifications during retries

Push notifications are intentionally deferred. Flutter can first consume the durable inbox and Socket.IO game events.

## B19 - Admin Backend Expansion

Admin operations now include:

- dashboard counts and settlement totals
- player list/detail and ACTIVE/BLOCKED management
- payment review endpoints from B4
- game/mode management from B5
- match list/detail/replay
- open/reviewed/dismissed risk flags
- audit-log listing

Admin user-status changes, payment decisions, and risk reviews are auditable.

## B20 - Risk and Anti-Cheat Baseline

The baseline is deterministic and explainable, not ML-based:

- server-authoritative dice and moves remain the primary anti-cheat control
- command-id dedupe and expected-version guards remain active
- repeated-opponent pattern flagging
- repeated timeout-forfeit flagging
- risk flags are durable and deduplicated by fingerprint
- admins review or dismiss flags; flags do not automatically seize funds or ban users

This is intentionally conservative. Automated punishment based on heuristics is deferred until real production data exists.

## Backend status after B20

The application path is now complete enough for Flutter integration:

`Auth -> Wallet -> Payments -> Matchmaking -> Escrow -> Realtime Ludo -> Timeout/Reconnect -> Settlement -> History/Notifications`

Before a public production launch, deployment hardening, load testing, backups, metrics, and security review are still required. Those tasks can proceed after the Flutter client is functionally integrated; they do not need to block beginning mobile development.
