# B9-B10 Implemented — Ludo Match Runtime + Simulation/QA

## B9 — Ludo Match Runtime

`src/games/ludo/runtime/` is the single in-process owner of Ludo match lifecycle transitions. It deliberately has no NestJS controller, Socket.IO gateway, Redis client, Prisma client, scheduler, or wall-clock dependency.

Implemented runtime flow:

```text
PRE_GAME / START_ROLL
  -> each eligible player rolls once
  -> highest roll starts
  -> tied leaders reroll only against each other

PLAYING / WAITING_FOR_ROLL
  -> ROLL_DICE
  -> third consecutive six forfeits that third roll and ends the turn
  -> no legal move is resolved server-side without asking the client to repair state
  -> otherwise legal token ids are frozen for the move phase

PLAYING / WAITING_FOR_MOVE
  -> MOVE_TOKEN
  -> pure B7 engine validates and applies movement
  -> capture / token finish events derived from the authoritative result
  -> six grants another roll unless the player has finished
  -> otherwise runtime advances to the next active player

FINISHED
  -> complete winner order is frozen
```

### Command boundary

Supported commands:

- `ROLL_FOR_START`
- `ROLL_DICE`
- `MOVE_TOKEN`
- `RESIGN`

Every command carries:

- `commandId`
- `playerId`
- `expectedVersion`

The runtime rejects stale versions with `MATCH_VERSION_CONFLICT`.

An identical retry using the same `commandId` returns the previously produced result without executing the mutation again. Reusing the same command id with different command content returns `COMMAND_ID_REUSE`.

The current B9 implementation intentionally keeps this idempotency cache in memory because B9 is infrastructure-free. B12 Redis/runtime persistence must make command deduplication durable across process restart or multi-instance execution. Do not treat the in-memory map as the production distributed idempotency solution.

### Versioning

Each accepted state-changing command increments the match version exactly once. Secondary lifecycle work caused by that command — such as moving to the next player — occurs under the same resulting version.

This makes later realtime messages easy to reason about:

```text
client v41
server command expectedVersion=41
server result v42
socket event v42
```

If a client later sees a gap, B14 recovery will request one authoritative snapshot instead of running normal gameplay through constant canonical sync.

### Consecutive six decision

`LUDO_CLASSIC_V1` uses the frozen Friends Game Hub interpretation:

- first six: move, then extra roll
- second consecutive six: move, then extra roll
- third consecutive six: the third roll is forfeited before movement; the turn ends

The previous two moves remain valid.

### No-legal-move behavior

The runtime resolves this itself:

- non-six + no legal move -> next player
- six + no legal move -> extra roll, unless it becomes the third consecutive six

The client never needs a fake move or repair command.

### Winner and resignation behavior

For 1v1, the first player to finish all four tokens ends the match immediately and the other player is ranked second.

The runtime also supports 2-4 player ranking: finished players are skipped for future turns and play continues until only one active player remains. Resigned players rank behind players who stayed active. Paid launch remains 1v1, so multi-player behavior is currently engine/runtime readiness rather than a commercial mode commitment.

## B10 — Simulation & Engine QA

Implemented under `src/games/ludo/simulation/`.

### Bots

- `RandomBot`
- `DefensiveBot`
- `AggressiveBot`
- `FastBot`
- `MixedBot`

The strategy categories follow the uploaded Ludo research paper. The mixed bot uses the paper's priority order:

```text
defensive -> aggressive -> fast -> random
```

The simulation bots are QA tools, not claims of production-optimal play. In particular, the defensive heuristic uses the actual Friends Game Hub legal-move engine to determine whether a token can be captured in one opponent die roll, rather than reproducing every experimental assumption in the paper.

### Deterministic simulation

A simulation uses `SeededDiceProvider`, records every consumed die value and every accepted command, and saves the final state.

`replayLudoSimulation()` then creates a fresh runtime with `FixedDiceProvider`, replays the same command transcript, and requires the complete final game state to match exactly.

This proves the Ludo engine/runtime is deterministic for a given command + dice history.

### Invariants checked continuously

Every accepted simulation command validates the B6 state invariants, including:

- valid player/token ownership
- valid token state/progress pairing
- no token past exact finish
- no opposing coexistence on non-safe squares
- no opponent coexistence with a same-owner blockade
- valid current player
- valid die range
- valid consecutive-six count
- legal token references only
- final ranking contains every participant exactly once

### Fuzz coverage

Two runnable QA tools are included:

```bash
npm run simulate:ludo -- 5000
npm run fuzz:ludo -- 1000
```

`simulate:ludo` cycles strategy pairings in 1v1 matches and deterministically replays a sample.

`fuzz:ludo` varies 2-, 3-, and 4-player matches and mixes bot strategies, while checking invariants and replaying a sample.

### Validation performed while building B10

The generated package was exercised with:

- 3,000 complete 1v1 simulations
- 100 exact deterministic replays from that run
- 1,000 mixed 2/3/4-player fuzz simulations
- 50 exact deterministic replays from the fuzz run
- focused B9 smoke checks for third-six forfeiture and command idempotency

All completed successfully after one B7 edge case was discovered by simulation and fixed: a player could previously move a second own token onto a safe square already shared by one own token and one opponent token, thereby creating a blockade that illegally coexisted with the opponent. Legal-move calculation now rejects that move before mutation, and a regression test was added.

The simulation win totals are not a scientific strategy benchmark because the CLI deliberately cycles non-balanced strategy pairings for broad engine coverage. Use a dedicated controlled experiment if strategy performance itself needs to be measured.

## What is intentionally still missing

B9-B10 do not add:

- Socket.IO
- Redis
- distributed locks
- durable command-idempotency storage
- turn wall-clock timers
- disconnect/reconnect handling
- matchmaking
- wallet entry/escrow
- settlement

Those are later phases and must wrap the proven runtime rather than duplicate its lifecycle logic.
