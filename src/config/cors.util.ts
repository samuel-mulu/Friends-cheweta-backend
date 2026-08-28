import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

export function buildCorsOptions(corsOrigins: string): CorsOptions {
  const origins = corsOrigins
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  // Browsers reject Access-Control-Allow-Origin: * when credentials are enabled.
  // Reflect the request origin instead so dev clients (e.g. Flutter web on random ports) work.
  if (origins.includes('*')) {
    return { origin: true, credentials: true };
  }

  return { origin: origins, credentials: true };
}
