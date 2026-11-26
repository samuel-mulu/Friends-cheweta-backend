import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { normalizeEthiopianPhone } from '../common/utils/phone.util';

type SmsPayload = {
  error?: boolean;
  success?: boolean;
  status?: string;
  otp?: unknown;
  pin?: unknown;
  code?: unknown;
  balance?: unknown;
  total_sms?: unknown;
  credits?: unknown;
  currency?: unknown;
  data?: SmsPayload;
};

@Injectable()
export class GeezSmsService {
  private readonly logger = new Logger(GeezSmsService.name);

  constructor(private readonly config: ConfigService) {}

  get enabled() {
    return (
      this.config.get<string>('GEEZSMS_ENABLED') === 'true' &&
      Boolean(this.config.get<string>('GEEZSMS_TOKEN')?.trim())
    );
  }

  async sendOtp(phone: string): Promise<string> {
    const url = this.endpoint('/sms/otp');
    url.search = this.params(phone).toString();
    const body = await this.request(url);
    const code = [body.otp, body.pin, body.data?.otp, body.data?.pin, body.data?.code, body.code]
      .map((value) => (typeof value === 'number' ? String(value).padStart(4, '0') : value))
      .find((value): value is string => typeof value === 'string' && /^\d{4}$/.test(value));
    if (!code) throw this.unavailable();
    return code;
  }

  async balance() {
    const empty = { enabled: this.enabled, balance: null, currency: null };
    if (!this.enabled) return empty;
    try {
      const url = this.endpoint('/balance');
      const params = this.params();
      const billing = this.config.get<string>('GEEZSMS_BILLING_ID');
      if (billing) params.set('billing_id', billing);
      url.search = params.toString();
      const body = await this.request(url, {
        headers: {
          'X-GeezSMS-Key': this.config.get<string>('GEEZSMS_API_KEY') || params.get('token')!,
        },
      });
      const smsCount = body.data?.total_sms ?? body.total_sms;
      const balance =
        body.data?.balance ?? body.balance ?? smsCount ?? body.data?.credits ?? body.credits;
      const currency = body.data?.currency ?? body.currency ?? (smsCount == null ? null : 'SMS');
      return {
        enabled: true,
        balance:
          typeof balance === 'number' || typeof balance === 'string' ? String(balance) : null,
        currency: typeof currency === 'string' ? currency : null,
      };
    } catch {
      return empty;
    }
  }

  async notifyWithdrawal(amountMinor: bigint, channel: string) {
    const recipients = this.config.get<string>('WITHDRAWAL_ADMIN_SMS_PHONES')?.split(',') ?? [];
    if (!this.enabled || !recipients.length) return;
    const amount =
      (amountMinor / 100n).toString() + '.' + (amountMinor % 100n).toString().padStart(2, '0');
    await Promise.allSettled(
      recipients.map(async (phone) => {
        try {
          const form = new FormData();
          this.params(normalizeEthiopianPhone(phone)).forEach((value, key) => form.set(key, value));
          form.set(
            'msg',
            `Cheweta withdrawal request: ${amount} ETB via ${channel}. Open the admin dashboard to review.`,
          );
          const callback = this.config.get<string>('GEEZSMS_CALLBACK_URL');
          const secret = this.config.get<string>('GEEZSMS_CALLBACK_SECRET');
          if (callback && secret) {
            const url = new URL(callback);
            url.searchParams.set('secret', secret);
            form.set('callback', url.toString());
          }
          await this.request(this.endpoint('/sms/send'), { method: 'POST', body: form });
        } catch {
          this.logger.warn('GeezSMS withdrawal notification failed');
        }
      }),
    );
  }

  private endpoint(path: string) {
    const base = this.config.get<string>('GEEZSMS_BASE_URL') || 'https://api.geezsms.com/api/v1';
    const url = new URL(base.replace(/\/+$/, '') + path);
    if (url.protocol !== 'https:') throw this.unavailable();
    return url;
  }

  private params(phone?: string) {
    if (!this.enabled) throw this.unavailable();
    const params = new URLSearchParams({ token: this.config.get<string>('GEEZSMS_TOKEN')!.trim() });
    if (phone) {
      params.set('phone', phone);
      const shortcode = this.config.get<string>('GEEZSMS_SHORTCODE_ID');
      if (shortcode) params.set('shortcode_id', shortcode);
    }
    return params;
  }

  private async request(url: URL, init?: RequestInit): Promise<SmsPayload> {
    try {
      const response = await fetch(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      });
      const body = (await response.json()) as SmsPayload;
      if (
        !response.ok ||
        !body ||
        body.error === true ||
        body.success === false ||
        ['failed', 'error', 'rejected', 'invalid'].includes(String(body.status).toLowerCase())
      ) {
        throw this.unavailable();
      }
      return body;
    } catch {
      this.logger.warn('GeezSMS request failed');
      throw this.unavailable();
    }
  }

  private unavailable() {
    return new ServiceUnavailableException({
      code: 'SMS_UNAVAILABLE',
      message: 'SMS is temporarily unavailable. Try again shortly.',
    });
  }
}
