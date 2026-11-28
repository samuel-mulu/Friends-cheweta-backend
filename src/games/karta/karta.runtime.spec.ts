import { rankOf, shuffledDeck } from './karta.deck';
import { createKartaMatch, executeKartaCommand } from './karta.runtime';
import { KARTA_TABLE_V1, KARTA_V1, KartaMatchRuntimeState, KartaRank } from './karta.types';

const seeds = ['seed-1', 'seed-2', 'seed-3', 'seed-4', 'seed-5', 'seed-6'];
const seedSource = () => {
  let next = 0;
  return () => seeds[next++ % seeds.length];
};

let commandSeq = 0;
function run(
  state: KartaMatchRuntimeState,
  playerId: string,
  body: { type: 'CALL'; rank: KartaRank } | { type: 'FLIP' } | { type: 'RESIGN' },
  newSeed: () => string,
) {
  return executeKartaCommand(
    state,
    { ...body, playerId, commandId: `c${++commandSeq}`, expectedVersion: state.game.version },
    newSeed,
  );
}

/** Call the rank of the card at [index] of this round's deck, then flip until it lands. */
function playRound(state: KartaMatchRuntimeState, index: number, newSeed: () => string) {
  const rank = rankOf(shuffledDeck(state.secret.seed)[index]);
  let current = run(state, state.game.callerId, { type: 'CALL', rank }, newSeed).state;
  const round = current.game.round;
  while (current.game.phase === 'PLAYING' && current.game.round === round) {
    current = run(current, current.game.starterId, { type: 'FLIP' }, newSeed).state;
  }
  return current;
}

describe('Karta Lat Lat 1v1 (KARTA_LATLAT_V1)', () => {
  it('the other player calls; cards go caller, starter, caller… and a win needs 3 rounds', () => {
    const newSeed = seedSource();
    let state = createKartaMatch('m1', ['a', 'b'], 'a', newSeed);
    expect(state.game).toMatchObject({
      rulesVersion: KARTA_V1,
      targetScore: 3,
      starterId: 'a',
      callerId: 'b',
      currentPlayerId: 'b',
    });

    // A rank that is not among the first three cards: watch the alternation.
    const deck = shuffledDeck(state.secret.seed);
    const firstHit = deck.findIndex(
      (card, i) => i >= 3 && !deck.slice(0, 3).some((c) => rankOf(c) === rankOf(card)),
    );
    state = run(state, 'b', { type: 'CALL', rank: rankOf(deck[firstHit]) }, newSeed).state;
    const receivers: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      receivers.push(state.game.receiverId!);
      state = run(state, 'a', { type: 'FLIP' }, newSeed).state;
    }
    expect(receivers).toEqual(['b', 'a', 'b']);
  });

  it('the round winner starts the next round; the match ends at 3', () => {
    const newSeed = seedSource();
    let state = createKartaMatch('m1', ['a', 'b'], 'a', newSeed);
    // The called rank on the first card: the caller (b) wins and starts next.
    state = playRound(state, 0, newSeed);
    expect(state.game.scores).toEqual({ a: 0, b: 1 });
    expect(state.game).toMatchObject({ starterId: 'b', callerId: 'a', phase: 'PLAYING' });
    // On the second card: the starter (b) wins and keeps starting.
    state = playRound(state, 1, newSeed);
    expect(state.game).toMatchObject({ starterId: 'b', phase: 'PLAYING' });
    expect(state.game.scores).toEqual({ a: 0, b: 2 });
    state = playRound(state, 1, newSeed);
    expect(state.game).toMatchObject({ phase: 'FINISHED', finishReason: 'SCORE' });
    expect(state.game.winnerOrder).toEqual(['b', 'a']);
  });

  it('resigning makes the other player win at once', () => {
    const newSeed = seedSource();
    const state = createKartaMatch('m1', ['a', 'b'], 'a', newSeed);
    const after = run(state, 'a', { type: 'RESIGN' }, newSeed).state;
    expect(after.game).toMatchObject({ phase: 'FINISHED', finishReason: 'RESIGN' });
    expect(after.game.winnerOrder).toEqual(['b', 'a']);
  });
});

describe('Karta table round (KARTA_TABLE_V1)', () => {
  it('seat 0 starts, the receiver calls, and one round decides it', () => {
    const newSeed = seedSource();
    let state = createKartaMatch('r1', ['starter', 'receiver'], 'starter', newSeed, KARTA_TABLE_V1);
    expect(state.game).toMatchObject({
      rulesVersion: KARTA_TABLE_V1,
      targetScore: 1,
      starterId: 'starter',
      callerId: 'receiver',
    });
    // The second card goes to the starter: the starter wins the round.
    state = playRound(state, 1, newSeed);
    expect(state.game).toMatchObject({ phase: 'FINISHED', finishReason: 'SCORE' });
    expect(state.game.winnerOrder).toEqual(['starter', 'receiver']);
  });
});
