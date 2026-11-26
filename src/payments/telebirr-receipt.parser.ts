export type TelebirrReceipt = {
  invoiceNumber: string;
  transactionStatus: string;
  settledAmount: string;
  creditedPartyName: string;
  creditedPartyAccountNo: string;
};

export function parseTelebirrReceiptHtml(
  html: string,
  transactionRef: string,
): TelebirrReceipt | null {
  const normalizedRef = normalizeCode(transactionRef);
  if (!normalizedRef) {
    return null;
  }

  const settledAmount =
    findSettledAmountForInvoice(html, normalizedRef) ??
    findValueAfterLabels(html, ['Settled Amount']);
  const creditedPartyName = findValueAfterLabels(html, [
    'Credited Party name',
    'Credited party name',
  ]);
  const creditedPartyAccountNo = findValueAfterLabels(html, [
    'Credited party account no',
    'Credited party account no.',
  ]);
  const transactionStatus = findValueAfterLabels(html, [
    'transaction status',
    'Transaction Status',
  ]);

  if (!settledAmount || !creditedPartyName || !creditedPartyAccountNo || !transactionStatus) {
    return null;
  }

  const invoiceNumber = htmlIncludesInvoice(html, normalizedRef) ? normalizedRef : null;
  if (!invoiceNumber) {
    return null;
  }

  return {
    invoiceNumber,
    transactionStatus: transactionStatus.trim(),
    settledAmount,
    creditedPartyName: creditedPartyName.trim(),
    creditedPartyAccountNo: creditedPartyAccountNo.trim(),
  };
}

function findSettledAmountForInvoice(html: string, normalizedRef: string): string | null {
  const pattern = new RegExp(
    `<td[^>]*>\\s*${escapeRegex(normalizedRef)}\\s*</td>\\s*<td[^>]*>[^<]*</td>\\s*<td[^>]*>\\s*([^<]+)</td>`,
    'i',
  );
  const match = html.match(pattern);
  return match ? cleanMoney(match[1]) : null;
}

function htmlIncludesInvoice(html: string, normalizedRef: string): boolean {
  const pattern = new RegExp(`<td[^>]*>\\s*${escapeRegex(normalizedRef)}\\s*</td>`, 'i');
  return pattern.test(html);
}

function findValueAfterLabels(html: string, labels: string[]): string | null {
  for (const label of labels) {
    const pattern = new RegExp(
      `${escapeRegex(label)}[\\s\\S]*?<td[^>]*>\\s*([^<]+?)\\s*</td>`,
      'i',
    );
    const match = html.match(pattern);
    if (match?.[1]) {
      const value = decodeHtmlEntities(match[1].trim());
      if (value.length > 0 && !looksLikeLabel(value)) {
        return value;
      }
    }
  }

  return null;
}

function cleanMoney(raw: string): string | null {
  const match = raw.replace(/,/g, '').match(/\d+(?:\.\d{1,2})?/);
  return match?.[0] ?? null;
}

function looksLikeLabel(value: string): boolean {
  const normalized = normalizeText(value);
  return (
    normalized.includes('invoice no') ||
    normalized.includes('settled amount') ||
    normalized.includes('payment date')
  );
}

function normalizeCode(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number.parseInt(code, 10)));
}
