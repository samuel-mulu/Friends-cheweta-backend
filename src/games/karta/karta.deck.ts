import { createHash } from 'node:crypto';
import { KARTA_RANKS, KARTA_SUITS, KartaCard, KartaRank } from './karta.types';

export const fullDeck = (): KartaCard[] => KARTA_RANKS.flatMap((rank) => KARTA_SUITS.map((suit) => `${rank}${suit}`));

export const rankOf = (card: KartaCard): KartaRank => card.slice(0, -1) as KartaRank;

const sha256 = (text: string): Buffer => createHash('sha256').update(text).digest();

/** Published before the call: binds the server to the deck order. */
export const commitmentOf = (seed: string): string => sha256(seed).toString('hex');

/**
 * Deterministic Fisher–Yates from the seed: swap index i with
 * `uint48(SHA-256(seed + ':' + i)) mod (i + 1)`, for i = 51 … 1.
 * Anyone with the revealed seed can rebuild exactly the same deck.
 */
export function shuffledDeck(seed: string): KartaCard[] {
  const deck = fullDeck();
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = sha256(`${seed}:${i}`).readUIntBE(0, 6) % (i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
