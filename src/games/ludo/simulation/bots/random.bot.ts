import { LudoGameState } from '../../domain';
import { LudoLegalMove } from '../../engine';
import { BotRandom, LudoBot } from './bot.types';

export class RandomBot implements LudoBot {
  readonly name = 'RANDOM';
  private readonly random: BotRandom;

  constructor(seed = 1) {
    this.random = new BotRandom(seed);
  }

  chooseMove(
    _state: LudoGameState,
    _playerId: string,
    _diceValue: number,
    legalMoves: readonly LudoLegalMove[],
  ): LudoLegalMove {
    if (legalMoves.length === 0) throw new Error('BOT_NO_LEGAL_MOVE');
    return legalMoves[this.random.nextInt(legalMoves.length)];
  }
}
