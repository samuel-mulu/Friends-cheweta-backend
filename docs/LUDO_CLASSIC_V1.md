# Friends Game Hub — LUDO_CLASSIC_V1

Status: frozen domain rules for B6. The move engine is implemented in B7+, not in B6.

## Source-supported rules adopted

The supplied rules describe Ludo as a 2–4 player game with four pieces per player, clockwise movement, a six required to deploy a piece from base, an extra roll after a six, capture by landing on an opponent, own-piece blocking, exact roll into the final home, and victory when all four pieces finish.

The supplied rules also state that three consecutive sixes lose the turn. They do not precisely define whether the third six is moved before the turn is lost. The detailed supplied rules do not state that capture or finishing a token grants an extra roll.

## Friends Game Hub decisions where the supplied material is ambiguous

These decisions are part of `LUDO_CLASSIC_V1`; they are not silently presented as universal Ludo rules.

- The third consecutive six is forfeited: no token moves for the third six and the turn ends.
- Capture does not grant an extra roll. A six remains the only gameplay bonus-roll trigger in V1.
- Finishing a token does not grant an extra roll.
- The canonical common track has 52 cells. Relative progress `0..51` is the common track, `52..56` is the five-cell home column, and `57` means finished.
- Two-player games use opposite colors: Red and Yellow.
- The canonical global start indexes are Red 0, Green 13, Yellow 26, Blue 39.
- The canonical safe global squares are `0, 8, 13, 21, 26, 34, 39, 47`.
- Safe squares permit opposing single tokens to coexist without capture.
- Two or more same-owner tokens on one common-track square form a blockade. Opponents cannot land on or pass through that blockade, including when the square is safe. The owner may pass or add another own token.
- Up to four own tokens may occupy one square.
- If a roll produces no legal move, the turn advances unless the turn rule grants another roll for a separately resolved six condition.
- Starting player is decided by pre-game highest die roll; tied highest players reroll until the tie is resolved.

## Domain representation

The backend engine uses logical progress, never Flutter pixel coordinates.

```text
BASE = -1
COMMON TRACK = 0..51
HOME COLUMN = 52..56
FINISHED = 57
```

For common-track positions only:

```text
globalSquare = (playerStartIndex + relativeProgress) % 52
```

This lets capture, safe-square and blockade logic compare players on one shared coordinate system while Flutter remains free to render any visual board geometry.

## Token state machine

```text
BASE -> ACTIVE -> HOME_PATH -> FINISHED
          |
          +----capture----> BASE
```

No other token-state transition is valid.

## B6 boundary

B6 defines and validates the domain model only. It intentionally does not implement dice generation, legal move calculation, capture resolution, blockade traversal, turn progression, winner resolution, Socket.IO, Redis or persistence of live Ludo state. Those belong to later phases so the engine stays testable and boundaries remain clear.
