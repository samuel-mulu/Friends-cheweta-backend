import { createHash } from 'node:crypto';
import { DiceProvider } from './dice-provider';

const UINT32_SPACE = 0x1_0000_0000;
const ACCEPT_LIMIT = Math.floor(UINT32_SPACE / 6) * 6;

function uniformDieFromDigestFactory(makeDigest: (attempt: number) => Buffer): number {
  for (let attempt = 0; ; attempt += 1) {
    const digest = makeDigest(attempt);
    for (let offset = 0; offset + 4 <= digest.length; offset += 4) {
      const value = digest.readUInt32BE(offset);
      if (value < ACCEPT_LIMIT) return (value % 6) + 1;
    }
  }
}

/** Deterministic provider for simulations and reproducible tests. Not a public fairness protocol. */
export class SeededDiceProvider implements DiceProvider {
  private rollIndex = 0;

  constructor(private readonly seed: string) {
    if (!seed) throw new Error('Seed is required.');
  }

  roll(): number {
    const index = this.rollIndex;
    this.rollIndex += 1;
    return uniformDieFromDigestFactory((attempt) =>
      createHash('sha256').update(`${this.seed}:${index}:${attempt}`).digest(),
    );
  }

  getRollIndex(): number {
    return this.rollIndex;
  }
}
