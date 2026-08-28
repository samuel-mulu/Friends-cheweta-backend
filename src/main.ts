import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { buildCorsOptions } from './config/cors.util';
import { AppEnv } from './config/env';
import { RedisService } from './redis/redis.service';
import { RedisIoAdapter } from './realtime/redis-io.adapter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService<AppEnv, true>);

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
