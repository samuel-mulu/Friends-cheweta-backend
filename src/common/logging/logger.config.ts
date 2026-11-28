import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';

type RequestWithId = IncomingMessage & { requestId?: string };

/**
 * One JSON line per log entry in production (pretty text in development).
 * Every HTTP request gets an id — the caller's `x-request-id` or a new one —
 * which is returned in the response header, added to each log line written
 * while handling the request, and included in error responses.
 */
export function loggerConfig(nodeEnv: string): Params {
  return {
    pinoHttp: {
      level: nodeEnv === 'test' ? 'silent' : 'info',
      transport:
        nodeEnv === 'development'
          ? { target: 'pino-pretty', options: { singleLine: true } }
          : undefined,
      genReqId: (req: RequestWithId, res: ServerResponse) => {
        const header = req.headers['x-request-id'];
        const requestId = (Array.isArray(header) ? header[0] : header)?.trim() || randomUUID();
        req.requestId = requestId;
        res.setHeader('x-request-id', requestId);
        return requestId;
      },
      customAttributeKeys: { reqId: 'requestId', responseTime: 'durationMs' },
      // Method, path and status only: never headers (tokens) or bodies.
      serializers: {
        req: (req: { method: string; url: string }) => ({
          method: req.method,
          path: req.url.split('?')[0],
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      autoLogging: { ignore: (req: IncomingMessage) => req.url === '/api/health' },
    },
  };
}
