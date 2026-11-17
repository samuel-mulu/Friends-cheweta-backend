import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { buildCorsOptions } from './config/cors.util';
import { AppEnv } from './config/env';
import { RedisService } from './redis/redis.service';
import { RedisIoAdapter } from './realtime/redis-io.adapter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const config = app.get(ConfigService<AppEnv, true>);

  // Behind the reverse proxy the client address is in X-Forwarded-For; rate
  // limits and session records must see it, not the proxy's address.
  app.set('trust proxy', config.get('TRUST_PROXY_HOPS', { infer: true }));

  app.setGlobalPrefix('api');
  app.use(helmet());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());

  app.enableCors(buildCorsOptions(config.get('CORS_ORIGINS', { infer: true })));
  app.enableShutdownHooks();

  const redis = app.get(RedisService);
  await redis.connect();
  const socketAdapter = new RedisIoAdapter(app, redis, config);
  await socketAdapter.connectToRedis();
  app.useWebSocketAdapter(socketAdapter);

  await app.listen(config.get('PORT', { infer: true }));
}

void bootstrap();
