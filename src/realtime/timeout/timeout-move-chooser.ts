import { LudoGameState } from '../../games/ludo/domain';
import { LudoEngine } from '../../games/ludo/engine';
import { HeuristicBot } from '../../games/ludo/simulation/bots';

const engine = new LudoEngine();

/**
 * The token the server moves for a player whose turn timed out. Plays like an
 * experienced player (captures, getting home, safety) rather than picking the
 * first id alphabetically, so an absent player is not punished twice.
 * Deterministic per state so a retried timeout replays the same move.
 */
export function chooseTimeoutMove(game: LudoGameState, playerId: string): string | null {
  if (game.diceValue === null || game.legalTokenIds.length === 0) return null;
  const legal = engine
    .getLegalMoves(game, playerId, game.diceValue)
    .filter((move) => game.legalTokenIds.includes(move.tokenId));
  if (legal.length === 0) return null;
  if (legal.length === 1) return legal[0].tokenId;
  return new HeuristicBot(game.version).chooseMove(game, playerId, game.diceValue, legal).tokenId;
}
