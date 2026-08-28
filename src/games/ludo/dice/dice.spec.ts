import {
  CryptoDiceProvider,
  FixedDiceProvider,
  SeededDiceProvider,
  combineParticipantEntropy,
  createSeedCommitment,
  createServerSeed,
  deriveFairDice,
  verifySeedCommitment,
} from './index';

describe('Ludo dice B8', () => {
  it('CryptoDiceProvider always returns 1..6', () => {
    const dice = new CryptoDiceProvider();
    for (let i = 0; i < 200; i += 1) {
      const value = dice.roll();
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(6);
    }
  });

  it('FixedDiceProvider is strict and reproducible', () => {
    const dice = new FixedDiceProvider([6, 2, 4]);
    expect([dice.roll(), dice.roll(), dice.roll()]).toEqual([6, 2, 4]);
    expect(() => dice.roll()).toThrow('FIXED_DICE_SEQUENCE_EXHAUSTED');
  });

  it('SeededDiceProvider reproduces the same sequence for the same seed', () => {
    const a = new SeededDiceProvider('simulation-123');
    const b = new SeededDiceProvider('simulation-123');
    expect(Array.from({ length: 20 }, () => a.roll())).toEqual(Array.from({ length: 20 }, () => b.roll()));
  });

  it('creates and verifies a commit/reveal fairness foundation', () => {
    const seed = createServerSeed();
    const commitment = createSeedCommitment(seed);
    expect(verifySeedCommitment(seed, commitment)).toBe(true);
    expect(verifySeedCommitment('00'.repeat(32), commitment)).toBe(false);
  });

  it('derives deterministic verifiable rolls from seed, match and roll index', () => {
    const seed = '11'.repeat(32);
    const publicEntropy = combineParticipantEntropy(['player-a-seed', 'player-b-seed']);
    const first = deriveFairDice({ serverSeedHex: seed, matchId: 'match-42', rollIndex: 7, publicEntropy });
    const again = deriveFairDice({ serverSeedHex: seed, matchId: 'match-42', rollIndex: 7, publicEntropy });
    expect(first).toBe(again);
    expect(first).toBeGreaterThanOrEqual(1);
    expect(first).toBeLessThanOrEqual(6);
  });
});
