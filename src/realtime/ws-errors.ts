import { HttpException } from '@nestjs/common';

/** `{ code, message }` for any error thrown by a socket handler. */
export function toErrorPayload(error: unknown): { code: string; message: string } {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === 'object' && response !== null) {
      const value = response as { code?: string; message?: string | string[] };
      return {
        code: value.code ?? 'REQUEST_FAILED',
        message: Array.isArray(value.message) ? value.message.join(', ') : (value.message ?? error.message),
      };
    }
    return { code: 'REQUEST_FAILED', message: String(response) };
  }
  if (error instanceof Error) {
    // Domain errors are thrown as `new Error('SOME_CODE')`.
    const knownCode = /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'REALTIME_COMMAND_FAILED';
    return { code: knownCode, message: knownCode === error.message ? error.message : 'Realtime command failed.' };
  }
  return { code: 'REALTIME_COMMAND_FAILED', message: 'Realtime command failed.' };
}

export function toErrorAck(error: unknown): { ok: false; code: string; message: string } {
  return { ok: false, ...toErrorPayload(error) };
}
