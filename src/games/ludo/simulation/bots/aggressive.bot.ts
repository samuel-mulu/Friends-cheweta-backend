import { LudoGameState } from '../../domain';
import { LudoLegalMove } from '../../engine';
import { BotRandom, LudoBot } from './bot.types';
import { aggressiveMoves } from './strategy.helpers';

export class AggressiveBot implements LudoBot {
  readonly name = 'AGGRESSIVE';
  private readonly random: BotRandom;

  constructor(seed = 2) {
    this.random = new BotRandom(seed);
  }

  chooseMove(
    _state: LudoGameState,
    _playerId: string,
    _diceValue: number,
    legalMoves: readonly LudoLegalMove[],
  ): LudoLegalMove {
    if (legalMoves.length === 0) throw new Error('BOT_NO_LEGAL_MOVE');
    const preferred = aggressiveMoves(legalMoves);
    const pool = preferred.length > 0 ? preferred : legalMoves;
    return pool[this.random.nextInt(pool.length)];
  }
}
