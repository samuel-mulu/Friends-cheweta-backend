import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { requestId?: string }>();

    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const raw = exception instanceof HttpException ? exception.getResponse() : null;

    let code = status === 500 ? 'INTERNAL_SERVER_ERROR' : 'REQUEST_FAILED';
    let message: string | string[] = status === 500 ? 'Internal server error' : 'Request failed';
    let details: unknown;

    if (typeof raw === 'string') {
      message = raw;
    } else if (raw && typeof raw === 'object') {
      const body = raw as Record<string, unknown>;
      if (typeof body.code === 'string') code = body.code;
      if (typeof body.message === 'string' || Array.isArray(body.message)) message = body.message as string | string[];
      if ('details' in body) details = body.details;
    }

    response.status(status).json({
      statusCode: status,
      code,
      message,
      ...(details !== undefined ? { details } : {}),
      requestId: request.requestId,
      timestamp: new Date().toISOString(),
      path: request.originalUrl,
    });
  }
}
