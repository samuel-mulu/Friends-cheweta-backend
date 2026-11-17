import { ThrottlerModuleOptions } from '@nestjs/throttler';

const MINUTE_MS = 60_000;

/**
 * HTTP limits are counted per client IP. Mobile carriers put many players
 * behind one address, so the general limit is generous; it exists to stop a
 * runaway client or a scripted flood, not to shape normal use. Counters are
 * in memory, so with several API containers each one counts on its own.
 */
export const HTTP_RATE_LIMIT: ThrottlerModuleOptions = [
  { name: 'default', ttl: MINUTE_MS, limit: 600 },
];

/** Login, register, refresh: password guessing and account farming. */
export const AUTH_RATE_LIMIT = { default: { ttl: MINUTE_MS, limit: 30 } };

/** Creating deposits and withdrawals. */
export const PAYMENT_RATE_LIMIT = { default: { ttl: MINUTE_MS, limit: 30 } };

/** Socket events one connection may send per second (a fast player sends 2–3). */
export const SOCKET_EVENTS_PER_SECOND = 20;
