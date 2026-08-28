import { LudoGameState } from '../../domain';
import { LudoLegalMove } from '../../engine';
import { BotRandom, LudoBot } from './bot.types';
import { fastestMoves } from './strategy.helpers';

export class FastBot implements LudoBot {
  readonly name = 'FAST';
  private readonly random: BotRandom;

  constructor(seed = 3) {
    this.random = new BotRandom(seed);
  }

  chooseMove(
    _state: LudoGameState,
    _playerId: string,
    _diceValue: number,
    legalMoves: readonly LudoLegalMove[],
  ): LudoLegalMove {
    if (legalMoves.length === 0) throw new Error('BOT_NO_LEGAL_MOVE');
    const preferred = fastestMoves(legalMoves);
    return preferred[this.random.nextInt(preferred.length)];
  }
}
