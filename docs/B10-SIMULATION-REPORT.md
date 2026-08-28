# B10 Simulation Report

Run during B9-B10 implementation.

## 1v1 strategy-coverage run

```json
{
  "games": 3000,
  "replayed": 100,
  "averageCommands": 334,
  "wins": {
    "FAST": 600,
    "RANDOM": 561,
    "AGGRESSIVE": 600,
    "DEFENSIVE": 656,
    "MIXED": 583
  }
}
```

These win totals are **not** intended as a strategy-performance conclusion. Pairings are cycled for implementation coverage rather than balanced experimental comparison.

## Multi-player fuzz run

```json
{
  "games": 1000,
  "byPlayerCount": {
    "2": 334,
    "3": 333,
    "4": 333
  },
  "replayed": 50,
  "averageCommands": 595,
  "status": "passed"
}
```

The fuzz run continuously checked domain invariants and completed all matches inside the command safety limit.

## B7 issue found by B10

Simulation exposed a legal-move edge case involving shared safe squares:

```text
safe square contains:
- RED token
- YELLOW token

another RED token lands there
```

That would create a RED blockade while YELLOW still occupied the safe square, contradicting the frozen blockade invariant. B7 now rejects that destination during legal-move generation and includes a regression test.
