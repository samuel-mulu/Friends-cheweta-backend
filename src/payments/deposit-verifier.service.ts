import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { normalizeEthiopianPhone } from '../common/utils/phone.util';
import { PaymentChannel } from '../generated/prisma/enums';
import { DepositConfigService } from './deposit-config.service';
import { TelebirrReceipt } from './telebirr-receipt.parser';

export type VerificationResult =
  | { outcome: 'verified' }
  | { outcome: 'invalid'; code: string }
  | { outcome: 'pending' | 'unavailable'; requestId?: string };

type VerifyEtRecord = {
  verified?: boolean;
  status?: string;
  processingStatus?: string;
  amount?: string | number;
  currency?: string;
  transactionNumber?: string;
  referenceNumber?: string;
  reference?: string;
  settlementAccountMatch?: { matched?: boolean; submitted?: string };
};

type VerifyEtResponse = {
  requestId?: string;
  processingStatus?: string;
  verified?: boolean;
  verification?: VerifyEtRecord;
  data?: VerifyEtRecord | VerifyEtRecord[];
};

function toMinor(value: unknown) {
  const match = /^(\d{1,16})(?:\.(\d{1,2}))?$/.exec(String(value ?? '').trim());
  return match ? BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0')) : null;
}

function accountDigits(account: string) {
  return account.replace(/\D/g, '');
}

@Injectable()
export class DepositVerifierService {
  constructor(
    private readonly config: ConfigService,
    private readonly deposits: DepositConfigService,
  ) {}

  async local(reference: string, amountMinor: bigint): Promise<VerificationResult> {
    const receipt = await this.fetchReceipt(reference);
    if (!receipt) return { outcome: 'unavailable' };
    if (receipt === 'not_found') return { outcome: 'invalid', code: 'INVALID_RECEIPT' };
    const account = accountDigits(this.deposits.settlement('TELEBIRR').account);
    const receiver = accountDigits(receipt.creditedPartyAccountNo);
    if (
      receipt.invoiceNumber.trim().toUpperCase() !== reference ||
      receipt.transactionStatus.trim().toLowerCase() !== 'completed'
    ) {
      return { outcome: 'invalid', code: 'INVALID_RECEIPT' };
    }
    if (toMinor(receipt.settledAmount) !== amountMinor) {
      return { outcome: 'invalid', code: 'AMOUNT_MISMATCH' };
    }
    // Full account numbers must match. Masked receipts must identify both
    // the account suffix and the configured recipient name.
    const sameNumber = account === receiver || this.sameEthiopianNumber(account, receiver);
    const name = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');
    const expectedName = name(this.deposits.settlement('TELEBIRR').receiverName);
    const maskedMatch =
      /[*x]/i.test(receipt.creditedPartyAccountNo) &&
      receiver.length >= 4 &&
      account.endsWith(receiver) &&
      expectedName &&
      expectedName === name(receipt.creditedPartyName);
    if (!account || (!sameNumber && !maskedMatch)) {
      return { outcome: 'invalid', code: 'SETTLEMENT_MISMATCH' };
    }
    return { outcome: 'verified' };
  }

  async fetchReceipt(reference: string): Promise<TelebirrReceipt | 'not_found' | null> {
    const base = this.config.get<string>('TELEBIRR_VERIFIER_URL');
    const token = this.config.get<string>('TELEBIRR_VERIFIER_TOKEN');
    if (!base || !token) return null;
    try {
      const url = new URL(base);
      if (url.protocol !== 'https:') return null;
      url.searchParams.set('reference', reference);
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 404 || response.status === 422) return 'not_found';
      if (!response.ok) return null;
      const receipt = (await response.json()) as Partial<TelebirrReceipt>;
      if (
        typeof receipt?.invoiceNumber !== 'string' ||
        typeof receipt.transactionStatus !== 'string' ||
        typeof receipt.settledAmount !== 'string' ||
        typeof receipt.creditedPartyName !== 'string' ||
        typeof receipt.creditedPartyAccountNo !== 'string'
      )
        return null;
      return receipt as TelebirrReceipt;
    } catch {
      return null;
    }
  }

  private sameEthiopianNumber(left: string, right: string) {
    try {
      return normalizeEthiopianPhone(left) === normalizeEthiopianPhone(right);
    } catch {
      return false;
    }
  }

  async automatic(
    channel: PaymentChannel,
    reference: string,
    amountMinor: bigint,
    existingRequestId: string | null,
  ): Promise<VerificationResult> {
    const key = this.config.get<string>('VERIFY_ET_API_KEY');
    const settlementAccount = this.deposits.settlement(channel).account;
    const base = (this.config.get<string>('VERIFY_ET_BASE_URL') || 'https://verify.et').replace(
      /\/+$/,
      '',
    );
    if (!key || !settlementAccount) return { outcome: 'unavailable' };
    const requestBody: Record<string, string> = {
      bank: channel.toLowerCase(),
      settlementAccount,
      [channel === 'TELEBIRR' ? 'transactionNumber' : 'referenceNumber']: reference.toUpperCase(),
    };
    if (channel === 'CBE' || channel === 'BOA') {
      const length = channel === 'CBE' ? 8 : 5;
      const suffix = accountDigits(
        this.config.get<string>(`${channel}_ACCOUNT_SUFFIX`) || settlementAccount,
      ).slice(-length);
      if (suffix.length !== length) return { outcome: 'unavailable' };
      requestBody.accountSuffix = suffix;
      if (channel === 'CBE') requestBody.suffix = suffix;
    }
    // The same receipt and settlement destination always use the same key.
    // A timed-out POST can be retried safely before a request ID is known.
    const idempotency = createHash('sha256').update(JSON.stringify(requestBody)).digest('hex');
    let requestId = existingRequestId || undefined;
    try {
      const url = new URL(
        existingRequestId
          ? `${base}/api/verify/${encodeURIComponent(existingRequestId)}`
          : `${base}/api/verify?waitMs=5000`,
      );
      if (url.protocol !== 'https:') return { outcome: 'unavailable' };
      const response = await fetch(url, {
        method: existingRequestId ? 'GET' : 'POST',
        headers: {
          'x-api-key': key,
          'Content-Type': 'application/json',
          'Idempotency-Key': `cheweta-${idempotency}`,
        },
        body: existingRequestId ? undefined : JSON.stringify(requestBody),
        redirect: 'error',
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) return { outcome: 'unavailable', requestId };
      const body = (await response.json()) as VerifyEtResponse;
      if (typeof body.requestId === 'string' && /^[\w-]{1,160}$/.test(body.requestId)) {
        requestId = body.requestId;
      }
      const record = Array.isArray(body.data) ? body.data[0] : body.data;
      const state = (
        body.processingStatus ??
        body.verification?.processingStatus ??
        record?.processingStatus
      )?.toLowerCase();
      if (state === 'pending' || response.status === 202) return { outcome: 'pending', requestId };
      if (state !== 'completed' || !record) return { outcome: 'unavailable', requestId };
      if (
        record.verified === false ||
        ![body.verified, body.verification?.verified, record.verified].includes(true) ||
        (record.status && !['success', 'completed'].includes(record.status.toLowerCase()))
      ) {
        return { outcome: 'invalid', code: 'INVALID_RECEIPT' };
      }
      const returnedRef = record.transactionNumber ?? record.referenceNumber ?? record.reference;
      if (returnedRef && returnedRef.trim().toUpperCase() !== reference.toUpperCase()) {
        return { outcome: 'invalid', code: 'INVALID_RECEIPT' };
      }
      if (
        record.settlementAccountMatch?.matched !== true ||
        (record.settlementAccountMatch.submitted &&
          accountDigits(record.settlementAccountMatch.submitted) !==
            accountDigits(settlementAccount))
      ) {
        return { outcome: 'invalid', code: 'SETTLEMENT_MISMATCH' };
      }
      if (
        toMinor(record.amount) !== amountMinor ||
        (record.currency && record.currency.toUpperCase() !== 'ETB')
      ) {
        return { outcome: 'invalid', code: 'AMOUNT_MISMATCH' };
      }
      return { outcome: 'verified' };
    } catch {
      return { outcome: 'unavailable', requestId };
    }
  }
}
