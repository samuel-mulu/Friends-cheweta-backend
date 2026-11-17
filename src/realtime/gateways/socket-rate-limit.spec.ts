import { socketRateLimiter } from './socket-rate-limit';

describe('socketRateLimiter', () => {
  it('lets events through up to the limit, then answers RATE_LIMITED without delivering', () => {
    let time = 1_000_000;
    const limiter = socketRateLimiter(3, () => time);
    const next = jest.fn();
    const ack = jest.fn();

    for (let i = 0; i < 3; i += 1) limiter(['ludo:roll', {}, ack], next);
    expect(next).toHaveBeenCalledTimes(3);
    expect(ack).not.toHaveBeenCalled();

    limiter(['ludo:roll', {}, ack], next);
    expect(next).toHaveBeenCalledTimes(3);
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: 'RATE_LIMITED' }));

    // An event sent without an acknowledgement is simply dropped.
    expect(() => limiter(['match:reaction', {}], next)).not.toThrow();
    expect(next).toHaveBeenCalledTimes(3);

    // A new second starts a new window.
    time += 1000;
    limiter(['ludo:roll', {}, ack], next);
    expect(next).toHaveBeenCalledTimes(4);
  });
});
