import { INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { ServerOptions } from 'socket.io';
import { buildCorsOptions } from '../config/cors.util';
import { AppEnv } from '../config/env';
import { RedisService } from '../redis/redis.service';

export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor?: ReturnType<typeof createAdapter>;

  constructor(
    app: INestApplicationContext,
    private readonly redis: RedisService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    const pubClient = await this.redis.createConnectedDuplicate();
    const subClient = await this.redis.createConnectedDuplicate();
    this.adapterConstructor = createAdapter(pubClient, subClient);
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, {
      ...options,
      transports: ['websocket'],
      cors: buildCorsOptions(this.config.get('CORS_ORIGINS', { infer: true })),
    });

    if (!this.adapterConstructor) throw new Error('Redis Socket.IO adapter is not initialized.');
    server.adapter(this.adapterConstructor);
    return server;
  }
}
