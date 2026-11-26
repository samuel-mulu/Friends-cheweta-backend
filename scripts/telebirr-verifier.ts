import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { parseTelebirrReceiptHtml } from '../src/payments/telebirr-receipt.parser';

const token = process.env.TELEBIRR_VERIFIER_TOKEN;
if (!token || token.length < 32)
  throw new Error('Configure a Telebirr verifier token of at least 32 characters.');
const digest = (value: string) => createHash('sha256').update(value).digest();
const expectedAuthorization = digest(`Bearer ${token}`);
const receiptBase = 'https://transactioninfo.ethiotelecom.et/receipt';

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const reply = (status: number, data: object = {}) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(data));
  };
  if (
    request.method !== 'GET' ||
    url.pathname !== '/receipt' ||
    !timingSafeEqual(expectedAuthorization, digest(request.headers.authorization ?? ''))
  ) {
    reply(404);
    return;
  }
  const reference = url.searchParams.get('reference') ?? '';
  if (!/^[A-Z0-9-]{6,120}$/.test(reference)) {
    reply(400);
    return;
  }
  try {
    const upstream = await fetch(`${receiptBase}/${encodeURIComponent(reference)}`, {
      headers: { Accept: 'text/html,application/xhtml+xml' },
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
    if ([400, 404, 410, 422].includes(upstream.status)) {
      reply(404);
      return;
    }
    if (!upstream.ok) {
      reply(503);
      return;
    }
    const receipt = parseTelebirrReceiptHtml(await upstream.text(), reference);
    if (!receipt) {
      reply(422);
      return;
    }
    reply(200, receipt);
  } catch {
    reply(503);
  }
}).listen(Number(process.env.PORT || 8090), '0.0.0.0');
