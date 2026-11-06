import { BadRequestException } from '@nestjs/common';
import { WsAckExceptionFilter } from './ws-ack-exception.filter';

describe('WsAckExceptionFilter', () => {
  const host = (ack: unknown) => ({ getArgByIndex: (i: number) => (i === 2 ? ack : undefined) }) as any;

  it('answers a rejected payload through the ack instead of leaving the client waiting', () => {
    const ack = jest.fn();
    new WsAckExceptionFilter().catch(
      new BadRequestException(['tokensToWin must not be greater than 4']),
      host(ack),
    );
    expect(ack).toHaveBeenCalledWith({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'tokensToWin must not be greater than 4',
    });
  });

  it('does nothing when the client sent no ack', () => {
    expect(() => new WsAckExceptionFilter().catch(new BadRequestException('x'), host(undefined))).not.toThrow();
  });
});
