import { HttpException, Logger } from '@nestjs/common';

/**
 * Lightweight timing wrapper for financial database operations (settlement,
 * match creation, game entry, deposits, withdrawals). This intentionally
 * does not build a metrics/monitoring framework - it only logs through the
 * existing NestJS Logger so duration and outcome are visible in normal logs.
 */
export const FINANCIAL_OPERATION_WARN_THRESHOLD_MS = 2000;

export type FinancialOperationContext = Record<string, string | number | undefined>;

function formatContext(context: FinancialOperationContext): string {
  return Object.entries(context)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
}

/**
 * Extracts a safe, non-sensitive error code/reason for logging. Never
 * returns raw error payloads - financial exceptions in this codebase use
 * `{ code, message }` response bodies, so we surface only `code` (or the
 * exception class name as a fallback) and never the full response object.
 */
function safeErrorReason(error: unknown): string {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (response && typeof response === 'object' && 'code' in response) {
      const code = (response as { code?: unknown }).code;
      if (typeof code === 'string') return code;
    }
    return error.constructor.name;
  }
  if (error instanceof Error) return error.name || 'ERROR';
  return 'UNKNOWN_ERROR';
}

/**
 * Runs `fn`, logging a single structured line on completion:
 *   operation=SETTLEMENT matchId=<id> durationMs=843 status=success
 *   operation=SETTLEMENT matchId=<id> durationMs=5231 status=failure reason=MATCH_NOT_SETTLEABLE
 * Logs at `warn` level when the operation fails or exceeds
 * FINANCIAL_OPERATION_WARN_THRESHOLD_MS, otherwise at `log` level. Never
 * logs JWTs, passwords, secrets, or full payment payloads - only the caller
 * provided context (ids) and a safe error code.
 */
export async function withFinancialTiming<T>(
  logger: Logger,
  operation: string,
  context: FinancialOperationContext,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    const durationMs = Date.now() - startedAt;
    const line = `operation=${operation} ${formatContext(context)} durationMs=${durationMs} status=success`;
    if (durationMs > FINANCIAL_OPERATION_WARN_THRESHOLD_MS) {
      logger.warn(`${line} (exceeded ${FINANCIAL_OPERATION_WARN_THRESHOLD_MS}ms threshold)`);
    } else {
      logger.log(line);
    }
    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const reason = safeErrorReason(error);
    logger.warn(`operation=${operation} ${formatContext(context)} durationMs=${durationMs} status=failure reason=${reason}`);
    throw error;
  }
}
