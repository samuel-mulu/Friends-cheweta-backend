import { LudoGameState } from '../../domain';
import { LudoLegalMove } from '../../engine';
import { BotRandom, LudoBot } from './bot.types';
import { defensiveMoves } from './strategy.helpers';

export class DefensiveBot implements LudoBot {
  readonly name = 'DEFENSIVE';
  private readonly random: BotRandom;

  constructor(seed = 4) {
    this.random = new BotRandom(seed);
  }

  chooseMove(
    state: LudoGameState,
    playerId: string,
    diceValue: number,
    legalMoves: readonly LudoLegalMove[],
  ): LudoLegalMove {
    if (legalMoves.length === 0) throw new Error('BOT_NO_LEGAL_MOVE');
    const preferred = defensiveMoves(state, playerId, diceValue, legalMoves);
    const pool = preferred.length > 0 ? preferred : legalMoves;
    return pool[this.random.nextInt(pool.length)];
  }
}
