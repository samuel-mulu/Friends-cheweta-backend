/**
 * Karta queue table: who sits where. Pure, so every rule is easy to test.
 *
 * A table seats a starter (deals), a receiver (calls the rank) and a queue of
 * players waiting their turn: at most `maxSeats` in all (2–4). Each round is
 * a 1v1 Karta match between the starter and the receiver that pays at once.
 * The round winner is the next starter; the loser goes to the back of the
 * queue; the first player in the queue is the next receiver.
 *
 *   A starts, B receives, queue C D.  B wins → B starts, C receives, queue D A.
 */
export type KartaTableStatus = 'PLAYING' | 'BETWEEN' | 'CLOSED';

export type KartaTable = {
  id: string;
  gameId: string;
  gameModeId: string;
  /** Stake per round (minor units, as text); the two players may raise it. */
  stakeMinor: string;
  platformFeeBps: number;
  maxSeats: number;
  starterId: string;
  /** The current round's other player; null between rounds. */
  receiverId: string | null;
  /** Waiting players, next receiver first. */
  queue: string[];
  round: number;
  /** The current round's match; null between rounds. */
  matchId: string | null;
  status: KartaTableStatus;
  /** BETWEEN: when the next round starts (ms). */
  nextAt: number | null;
  /** A raise one current player asked for, waiting for the other's answer. */
  raise: { amountMinor: string; byUserId: string } | null;
  /** The last round's result, shown to everyone between rounds. */
  last: { round: number; winnerId: string; loserId: string; payoutMinor: string } | null;
  /** Players of the round in play who left the table (dropped when it ends). */
  leaving: string[];
  createdAt: string;
};

/** Everyone seated, in turn order: starter, receiver, then the queue. */
export const seatedIds = (table: KartaTable): string[] => [
  table.starterId,
  ...(table.receiverId ? [table.receiverId] : []),
  ...table.queue,
];

export const freeSeats = (table: KartaTable): number =>
  table.status === 'CLOSED' ? 0 : table.maxSeats - seatedIds(table).length;

/** The two players of the round in play (they alone may raise the stake). */
export const inRound = (table: KartaTable, userId: string): boolean =>
  table.status === 'PLAYING' && (table.starterId === userId || table.receiverId === userId);

/**
 * After a round: the winner starts next, the loser goes to the back of the
 * queue (unless they left the table). The receiver is picked when the next
 * round starts (see [nextRoundSeats]).
 */
export function afterRound(
  table: KartaTable,
  winnerId: string,
  loserId: string,
  payoutMinor: string,
  nowMs: number,
  pauseMs: number,
): KartaTable {
  const leftTable = table.leaving.includes(loserId);
  return {
    ...table,
    starterId: winnerId,
    receiverId: null,
    queue: [...table.queue.filter((id) => id !== loserId), ...(leftTable ? [] : [loserId])],
    matchId: null,
    status: 'BETWEEN',
    nextAt: nowMs + pauseMs,
    leaving: [],
    last: { round: table.round, winnerId, loserId, payoutMinor },
  };
}

/**
 * The next round's seats from everyone still able to play ([canPlay]): the
 * starter stays if they can, else the first in the queue takes over; the next
 * in the queue receives. Null when fewer than two can play (the table closes).
 */
export function nextRoundSeats(
  table: KartaTable,
  canPlay: (userId: string) => boolean,
): { starterId: string; receiverId: string; queue: string[]; dropped: string[] } | null {
  const order = [table.starterId, ...table.queue];
  const staying = order.filter(canPlay);
  const dropped = order.filter((id) => !staying.includes(id));
  if (staying.length < 2) return null;
  const [starterId, receiverId, ...queue] = staying;
  return { starterId, receiverId, queue, dropped };
}

/** Someone leaves while not playing a round: out of the seats at once. */
export function withoutPlayer(table: KartaTable, userId: string): KartaTable {
  if (table.starterId !== userId) {
    return { ...table, queue: table.queue.filter((id) => id !== userId) };
  }
  // The starter left between rounds: the first in the queue starts.
  const [next, ...rest] = table.queue;
  return next ? { ...table, starterId: next, queue: rest } : { ...table, status: 'CLOSED' };
}
