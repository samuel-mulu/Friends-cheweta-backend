# Ludo types and automatic matching

## Ludo types (rules versions)

A game mode (stake) picks one; a match plays its mode's rules. Everything not
listed is the classic V3 rules (board, dice, extra rolls, blockades, goal).

| Type | Rules version | Landing on a lone opponent (off a safe square) |
|---|---|---|
| መመለስ ያለበት (with sending back) | `LUDO_CLASSIC_V3` | It goes back to its yard (classic). |
| መመለስ የሌለበት (no sending back) | `LUDO_NO_CAPTURE_V1` | Nothing: both tokens share the square. A blockade still may not form on top of an opponent. No capture extra roll (nothing is captured). |
| መመለስ የረሳ ይሸነፋል (forget to send back and you lose) | `LUDO_MISSED_CAPTURE_V1` | Classic capture, and capturing is mandatory in a strict way: moving another token while a capture was possible **forfeits the match** (the move is not played; event `CAPTURE_MISSED` → `ludo:capture_missed`; state `missedCapturePlayerIds`). The app never hints captures in this type. |

- Rules live in `src/games/ludo/domain/ludo.rules.ts` (`captureEnabled`, `missedCaptureLoses`).
- Moves played *for* someone (turn timeouts, practice bots, the simulator) use
  `getChoosableMoves`, which always takes a capture when one exists, so the
  server never makes a player forfeit.
- `npm run fuzz:ludo` covers every rules version.

## Ready terms and automatic matching

`lobby:ready` carries what the player asks for:

- `tokensToWin` (Ludo only, 1–4, default 4): the goal.
- `autoMatch` (default true): start a match with the next player ready at the same terms.

Same terms = same game mode (game, type, stake), both with auto-match on, and
the same Ludo goal. The longest-waiting player is paired first.

Race safety: `ChallengeService.autoPair` checks eligibility, then
`PAIR_SCRIPT` (Redis Lua) re-checks both players atomically (READY, no open
request) and reserves them in the same step, creating the record directly as
`ACCEPTING` (kind `AUTO`). From there the normal accept path creates the match
(`Match.challengeId` is unique) or releases both to READY. A manual request
racing it fails cleanly (`RESERVE_SCRIPT` needs the target READY and
unreserved). A pair whose match failed to start, or where one declined the
other, is not auto-paired again for 30 s.

`LobbyMatchmakingService` is the single broadcast path for request outcomes:
it publishes the transition and re-tries pairing for anyone returned to READY;
the lobby gateway calls `pair` after every ready.

Manual requests play the waiting player's goal.

## Rollout

Deploy this backend **before** the app version that sends ready terms and
picks Ludo types. Create the new Ludo modes (admin: the type cards) only once
both are live; an older server rejects their rules versions and cannot start
those matches.
