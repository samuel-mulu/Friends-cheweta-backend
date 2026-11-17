type SocketEvent = unknown[];

/**
 * Per-connection flood guard, for `socket.use(...)`. Counts events in
 * one-second windows; an event over the limit is not delivered to any handler
 * and its acknowledgement (if the client asked for one) gets `RATE_LIMITED`.
 * The counter lives with the socket: no Redis call on the hot path.
 */
export function socketRateLimiter(limitPerSecond: number, now: () => number = Date.now) {
  let windowStart = 0;
  let count = 0;

  return (event: SocketEvent, next: (error?: Error) => void): void => {
    const time = now();
    if (time - windowStart >= 1000) {
      windowStart = time;
      count = 0;
    }
    count += 1;
    if (count <= limitPerSecond) return next();

    const ack = event[event.length - 1];
    if (typeof ack === 'function') {
      (ack as (response: unknown) => void)({
        ok: false,
        code: 'RATE_LIMITED',
        message: 'Too many requests. Slow down and try again.',
      });
    }
  };
}
