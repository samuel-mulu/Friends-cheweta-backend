import { LudoGameState } from '../../domain';
import { LudoLegalMove } from '../../engine';
import { BotRandom, LudoBot } from './bot.types';
import { aggressiveMoves, defensiveMoves, fastestMoves } from './strategy.helpers';

/** Defensive -> aggressive -> fast -> random, matching the research-paper hierarchy. */
export class MixedBot implements LudoBot {
  readonly name = 'MIXED';
  private readonly random: BotRandom;

  constructor(seed = 5) {
    this.random = new BotRandom(seed);
  }

  chooseMove(
    state: LudoGameState,
    playerId: string,
    diceValue: number,
    legalMoves: readonly LudoLegalMove[],
  ): LudoLegalMove {
    if (legalMoves.length === 0) throw new Error('BOT_NO_LEGAL_MOVE');

    const defensive = defensiveMoves(state, playerId, diceValue, legalMoves);
    if (defensive.length > 0) return defensive[this.random.nextInt(defensive.length)];

    const aggressive = aggressiveMoves(legalMoves);
    if (aggressive.length > 0) return aggressive[this.random.nextInt(aggressive.length)];

    const fast = fastestMoves(legalMoves);
    if (fast.length > 0) return fast[this.random.nextInt(fast.length)];

    return legalMoves[this.random.nextInt(legalMoves.length)];
  }
}
