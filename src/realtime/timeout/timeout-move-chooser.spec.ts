import { LudoMatchPhase, LudoTokenState, LudoTurnPhase, createInitialLudoState } from '../../games/ludo/domain';
import { LudoEngine } from '../../games/ludo/engine';
import { chooseTimeoutMove } from './timeout-move-chooser';

function waitingForMove(dice: number) {
  const game = createInitialLudoState('m', ['p1', 'p2'], 'LUDO_CLASSIC_V3');
  game.phase = LudoMatchPhase.PLAYING;
  game.turnPhase = LudoTurnPhase.WAITING_FOR_MOVE;
  game.currentPlayerId = 'p1';
  game.diceValue = dice;
  return game;
}

describe('chooseTimeoutMove', () => {
  it('returns null when there is nothing to move', () => {
    const game = waitingForMove(3);
    expect(chooseTimeoutMove(game, 'p1')).toBeNull();
  });

  it('prefers a capture over the alphabetically first token', () => {
    const game = waitingForMove(2);
    // RED-1 at 10 would capture YELLOW-1 (yellow 38 = global 12); RED-2 at 20 is a plain move.
    game.players[0].tokens[0].state = LudoTokenState.ACTIVE;
    game.players[0].tokens[0].progress = 10;
    game.players[0].tokens[1].state = LudoTokenState.ACTIVE;
    game.players[0].tokens[1].progress = 20;
    game.players[1].tokens[0].state = LudoTokenState.ACTIVE;
    game.players[1].tokens[0].progress = 38;
    game.legalTokenIds = new LudoEngine().getLegalTokenIds(game, 'p1', 2);

    expect(chooseTimeoutMove(game, 'p1')).toBe('RED-1');

    // Swap ids so the capture is not the alphabetically first token.
    game.players[0].tokens[0].id = 'RED-9';
    game.legalTokenIds = new LudoEngine().getLegalTokenIds(game, 'p1', 2);
    expect(chooseTimeoutMove(game, 'p1')).toBe('RED-9');
  });

  it('is deterministic for the same state', () => {
    const game = waitingForMove(3);
    for (const token of game.players[0].tokens) token.state = LudoTokenState.ACTIVE;
    game.players[0].tokens.forEach((token, i) => (token.progress = 5 + i * 9));
    game.legalTokenIds = new LudoEngine().getLegalTokenIds(game, 'p1', 3);
    expect(chooseTimeoutMove(game, 'p1')).toBe(chooseTimeoutMove(game, 'p1'));
  });
});
