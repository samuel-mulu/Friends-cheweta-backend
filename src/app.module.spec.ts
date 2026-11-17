// Placeholder settings: this test only builds the dependency graph. Nothing
// connects, because the application is compiled but never started.
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test',
  REDIS_URL: 'redis://127.0.0.1:1',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
});

import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';
import { GameRegistry } from './realtime/turn-game/game-registry';

describe('AppModule', () => {
  it('resolves every provider and registers each game once', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const codes = moduleRef
      .get(GameRegistry, { strict: false })
      .all()
      .map((game) => game.definition.code);
    expect(codes.sort()).toEqual(['DAMA', 'KARTA', 'LUDO']);
  });
});
