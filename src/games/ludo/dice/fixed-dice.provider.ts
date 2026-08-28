import { DiceProvider } from './dice-provider';

export class FixedDiceProvider implements DiceProvider {
  private index = 0;

  constructor(private readonly sequence: readonly number[]) {
    if (sequence.length === 0) throw new Error('Fixed dice sequence cannot be empty.');
    for (const value of sequence) {
      if (!Number.isInteger(value) || value < 1 || value > 6) {
        throw new RangeError('Fixed dice values must be integers from 1 to 6.');
      }
    }
  }

  roll(): number {
    if (this.index >= this.sequence.length) throw new Error('FIXED_DICE_SEQUENCE_EXHAUSTED');
    const value = this.sequence[this.index];
    this.index += 1;
    return value;
  }

  remaining(): number {
    return this.sequence.length - this.index;
  }
}
