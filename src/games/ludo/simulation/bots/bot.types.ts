import { LudoGameState } from '../../domain';
import { LudoLegalMove } from '../../engine';

export interface LudoBot {
  readonly name: string;
  chooseMove(
    state: LudoGameState,
    playerId: string,
    diceValue: number,
    legalMoves: readonly LudoLegalMove[],
  ): LudoLegalMove;
}

export class BotRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) throw new RangeError('maxExclusive must be positive.');
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state % maxExclusive;
  }
}
