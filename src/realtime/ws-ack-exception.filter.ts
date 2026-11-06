import { ArgumentsHost, BadRequestException, Catch, ExceptionFilter } from '@nestjs/common';

/**
 * A payload rejected by validation never reaches a handler, so nothing would
 * answer the client's ack: it would wait for its timeout ("stuck" tap).
 * Answer every rejected request with a readable error instead.
 */
@Catch(BadRequestException)
export class WsAckExceptionFilter implements ExceptionFilter {
  catch(exception: BadRequestException, host: ArgumentsHost): void {
    const ack = host.getArgByIndex(2);
    if (typeof ack !== 'function') return;
    const response = exception.getResponse() as { message?: string | string[] } | string;
    const message = typeof response === 'string' ? response : response.message;
    ack({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: Array.isArray(message) ? message.join(', ') : message ?? 'Invalid request.',
    });
  }
}
