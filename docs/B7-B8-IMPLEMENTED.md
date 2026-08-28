# B7-B8 Implemented — Ludo Pure Engine + Dice/Fairness

## B7 — Ludo Pure Engine

The Ludo engine is intentionally pure TypeScript. It has no NestJS, Prisma, PostgreSQL, Redis, Socket.IO, timers, or random-number dependency.

Implemented:

- base deployment only on a six
- legal move calculation per token
- logical 52-cell common-track movement
- transition into the private home column
- exact finish at progress 57
- capture on non-safe shared squares
- no capture on frozen safe squares
- same-owner stacking
- opponent blockade detection
- cannot land on or pass through opponent blockade
- owner may pass their own blockade
- immutable move application (input state is not mutated)
- monotonic state version increment on an applied move
- structured move resolution for future B9 domain events

### Boundary kept intentionally

B7 does not decide turn order, consecutive-six forfeiture, extra-roll progression, timeout, winner ordering, persistence, or Socket.IO. Those belong to B9 Ludo Match Runtime.

## B8 — Dice & Fairness

Implemented dice boundary:

- `DiceProvider`
- `CryptoDiceProvider` using Node `crypto.randomInt(1, 7)` for production-grade unbiased randomness
- `FixedDiceProvider` for exact edge-case tests
- `SeededDiceProvider` for deterministic simulations and reproducible debugging

Fairness foundation:

- cryptographically secure 32-byte server seed generation
- SHA-256 seed commitment before a match
- deterministic participant/client entropy combiner
- HMAC-SHA256 die derivation using rules version + match id + participant entropy + roll index
- rejection sampling to avoid modulo bias
- post-match seed commitment verification

This is only the cryptographic foundation. For a verifiable production flow, the server commitment must be fixed first, participant/client entropy must be fixed afterward, every roll index must be durable/auditable, and the server seed is revealed only after the match. This proves the published roll sequence is reproducible; operational controls must also prevent silently abandoning/restarting commitments to obtain a preferred sequence. B9/B13+ will own that lifecycle.
