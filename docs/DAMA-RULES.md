# Ethiopian Dama (ዳማ) — rules version `DAMA_ET_V1`

The server is authoritative: clients only ever send a move path, and the server
accepts it only if it is one of the legal moves below.

| Rule | DAMA_ET_V1 |
|---|---|
| Board | 8×8, play on the dark squares only (32). a1 (index 0) is dark. |
| Squares | index `row * 8 + col`; row 0 = Light's back rank, row 7 = Dark's. |
| Pieces | 12 each. Light on rows 0–2, Dark on rows 5–7. Light moves first; colours are assigned randomly per match. |
| Man move | one step diagonally forward to an empty square. |
| Man capture | short jump over an adjacent enemy piece, forward **and backward**. |
| Compulsory capture | if any capture exists, a capture must be played. |
| Max capture | only the sequences capturing the most pieces are legal (every piece counts 1). Equal maxima: player's choice. |
| Multi-capture | captured pieces stay on the board until the move ends: they block, and none can be jumped twice. |
| Promotion | a man that **ends** its move on the far row becomes a king. Passing the far row mid-capture does not crown it. |
| King | flies: slides any distance diagonally; captures an enemy at any distance on a clear line and may land on any empty square beyond it. |
| Win | the opponent has no pieces, or no legal move (being blocked is a loss), or resigns. |
| Draw | 40 consecutive plies (20 each) with no capture and no man moving. Stakes are refunded. |
| Timer | per move (game mode setting). A timeout plays a legal move for the player and adds a strike; 3 strikes forfeit. |

"Huffing" (blowing away a piece that failed to capture) does not apply online:
illegal moves are impossible and the app highlights pieces that must capture.

## Wire format

- Board: a 64-character string, `.` empty, `l`/`L` light man/king, `d`/`D` dark man/king.
- Move: `{ path: number[], captured: number[] }`; `path[0]` is the start square,
  then every landing square of a multi-capture.

## Tools

- `npm run fuzz:dama [games]` — random games; invariants are checked on every ply.
- `npm run bots:dama [games]` — practice levels against each other
  (EASY random, NORMAL minimax depth 2, HARD minimax depth 4).
