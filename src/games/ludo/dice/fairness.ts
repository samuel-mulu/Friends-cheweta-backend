import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { LUDO_CLASSIC_V1 } from '../domain';

const UINT32_SPACE = 0x1_0000_0000;
const ACCEPT_LIMIT = Math.floor(UINT32_SPACE / 6) * 6;

export type FairDiceProofInput = {
  serverSeedHex: string;
  matchId: string;
  rollIndex: number;
  /**
   * Public entropy fixed after the server commitment. In production this can
   * be derived from participant-provided client seeds so the server cannot
   * choose its committed seed after seeing all randomness inputs.
   */
  publicEntropy: string;
};

export function createServerSeed(): string {
  return randomBytes(32).toString('hex');
}

export function createSeedCommitment(serverSeedHex: string): string {
  assertSeed(serverSeedHex);
  return createHash('sha256').update(Buffer.from(serverSeedHex, 'hex')).digest('hex');
}

export function verifySeedCommitment(serverSeedHex: string, expectedCommitmentHex: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(expectedCommitmentHex)) return false;
  const actual = Buffer.from(createSeedCommitment(serverSeedHex), 'hex');
  const expected = Buffer.from(expectedCommitmentHex, 'hex');
  return timingSafeEqual(actual, expected);
}

/**
 * Combines participant/client entropy deterministically. Each value should be
 * created independently after the server commitment has been fixed. Sorting
 * makes the result independent of participant ordering.
 */
export function combineParticipantEntropy(values: readonly string[]): string {
  if (values.length === 0 || values.some((value) => !value)) {
    throw new Error('At least one non-empty participant entropy value is required.');
  }
  const canonical = [...values].sort().map((value) => `${value.length}:${value}`).join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Verifiable deterministic die derivation. Rejection sampling removes modulo
 * bias. The same revealed seed + public inputs always reproduce the same roll.
 */
export function deriveFairDice(input: FairDiceProofInput): number {
  assertSeed(input.serverSeedHex);
  if (!input.matchId.trim()) throw new Error('matchId is required.');
  if (!input.publicEntropy) throw new Error('publicEntropy is required.');
  if (!Number.isInteger(input.rollIndex) || input.rollIndex < 0) {
    throw new RangeError('rollIndex must be a non-negative integer.');
  }

  for (let attempt = 0; ; attempt += 1) {
    const context = [
      LUDO_CLASSIC_V1.version,
      input.matchId,
      input.publicEntropy,
      String(input.rollIndex),
      String(attempt),
    ].join(':');
    const digest = createHmac('sha256', Buffer.from(input.serverSeedHex, 'hex')).update(context).digest();
    for (let offset = 0; offset + 4 <= digest.length; offset += 4) {
      const value = digest.readUInt32BE(offset);
      if (value < ACCEPT_LIMIT) return (value % 6) + 1;
    }
  }
}

function assertSeed(serverSeedHex: string): void {
  if (!/^[0-9a-f]{64}$/i.test(serverSeedHex)) {
    throw new Error('Server seed must be exactly 32 bytes encoded as hexadecimal.');
  }
}
