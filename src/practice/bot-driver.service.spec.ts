import { normalizeEthiopianPhone } from '../common/utils/phone.util';
import { GameEntryService } from '../game-entry/game-entry.service';
import { LudoMatchPhase, LudoTurnPhase, createInitialLudoState } from '../games/ludo/domain';
import { LudoEngine } from '../games/ludo/engine';
import { LudoMatchRuntimeState } from '../games/ludo/runtime';
import { MatchStatus } from '../generated/prisma/enums';
import { LudoRuntimeRepository } from '../realtime/ludo-runtime.repository';
import { LudoRuntimeService } from '../realtime/ludo-runtime.service';
import { createTestRedis } from '../test-utils/redis-test.util';
import { BotDriverService, decideBotAction } from './bot-driver.service';
import { PRACTICE_BOTS } from './practice.constants';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function runtimeState(overrides: (s: LudoMatchRuntimeState) => void): LudoMatchRuntimeState {
  const game = createInitialLudoState('m1', ['human', 'bot'], 'LUDO_CLASSIC_V2');
  const state: LudoMatchRuntimeState = {
    game,
    startingRoll: { round: 1, candidatePlayerIds: ['human', 'bot'], rolls: {} },
    resignedPlayerIds: [],
  };
  overrides(state);
  return state;
}

describe('decideBotAction', () => {
  const bots = new Map([['bot', 'HARD' as const]]);

  it('rolls for start when the bot has not rolled yet', () => {
    expect(
      decideBotAction(
        runtimeState(() => undefined),
        bots,
      ),
    ).toEqual({ playerId: 'bot', type: 'ROLL_FOR_START' });
  });

  it("does nothing on the person's turn", () => {
    const state = runtimeState((s) => {
      s.game.phase = LudoMatchPhase.PLAYING;
      s.game.turnPhase = LudoTurnPhase.WAITING_FOR_ROLL;
      s.game.currentPlayerId = 'human';
    });
    expect(decideBotAction(state, bots)).toBeNull();
  });

  it('rolls on its turn and picks a legal token when it must move', () => {
    const state = runtimeState((s) => {
      s.game.phase = LudoMatchPhase.PLAYING;
      s.game.turnPhase = LudoTurnPhase.WAITING_FOR_ROLL;
      s.game.currentPlayerId = 'bot';
    });
    expect(decideBotAction(state, bots)).toEqual({ playerId: 'bot', type: 'ROLL_DICE' });

    state.game.turnPhase = LudoTurnPhase.WAITING_FOR_MOVE;
    state.game.diceValue = 6;
    const action = decideBotAction(state, bots);
    expect(action?.type).toBe('MOVE_TOKEN');
    expect(new LudoEngine().getLegalTokenIds(state.game, 'bot', 6)).toContain(action?.tokenId);
  });
});

describe('BotDriverService (full practice game, real Redis runtime)', () => {
  it('plays the bot side through the authoritative runtime until the match finishes', async () => {
    const { redis, cleanup } = await createTestRedis();
    const savedDelays = BotDriverService.delays;
    BotDriverService.delays = { ROLL_FOR_START: 0, ROLL_DICE: 0, MOVE_TOKEN: 0 };
    try {
      const match = {
        id: 'm1',
        status: MatchStatus.READY as MatchStatus,
        entrySecuredAt: new Date(),
        rulesVersion: 'LUDO_CLASSIC_V2',
        game: { code: 'LUDO' },
        participants: [
          { userId: 'human', seat: 0 },
          { userId: 'bot', seat: 1 },
        ],
      };
      const prisma = {
        match: {
          findUnique: jest.fn(async () => ({ ...match })),
          updateMany: jest.fn(async () => ({ count: 1 })),
        },
        matchParticipant: { findUnique: jest.fn(async () => ({ id: 'p' })) },
        user: {
          findMany: jest.fn(async () => [
            { id: 'human', isBot: false, phoneNumber: '+251922000001' },
            {
              id: 'bot',
              isBot: true,
              phoneNumber: normalizeEthiopianPhone(PRACTICE_BOTS.HARD.phone),
            },
          ]),
        },
      };
      const history = {
        persistExecution: jest.fn(async () => undefined),
        saveCheckpoint: jest.fn(async () => undefined),
        getCheckpoint: jest.fn(async () => null),
      };
      const config = { get: () => 3600 };
      const runtime = new LudoRuntimeService(
        prisma as any,
        redis,
        new LudoRuntimeRepository(redis, config as any),
        new GameEntryService(prisma as any, {} as any),
        { settleLudoMatch: jest.fn(async () => undefined) } as any,
        history as any,
      );
      const published: string[] = [];
      const driver = new BotDriverService(
        prisma as any,
        runtime,
        {
          publishExecution: (r: any) => published.push(...r.events.map((e: any) => e.type)),
        } as any,
        { afterManualExecution: jest.fn(async () => undefined) } as any,
      );
      driver.onModuleInit();

      // The person joins; the driver is kicked like the gateway does.
      await driver.consider(await runtime.getSnapshot('m1', 'human'));

      const engine = new LudoEngine();
      for (let step = 0; step < 4000; step += 1) {
        const state = (await runtime.getStoredSnapshot('m1'))!;
        const game = state.game;
        if (game.phase === LudoMatchPhase.FINISHED) break;
        const humanStartRoll =
          game.phase === LudoMatchPhase.PRE_GAME &&
          state.startingRoll.candidatePlayerIds.includes('human') &&
          state.startingRoll.rolls.human === undefined;
        const humanTurn = game.phase === LudoMatchPhase.PLAYING && game.currentPlayerId === 'human';
        const base = {
          matchId: 'm1',
          playerId: 'human',
          commandId: `h-${game.version}`,
          expectedVersion: game.version,
        };
        try {
          if (humanStartRoll) await runtime.execute({ ...base, type: 'ROLL_FOR_START' });
          else if (humanTurn && game.turnPhase === LudoTurnPhase.WAITING_FOR_ROLL)
            await runtime.execute({ ...base, type: 'ROLL_DICE' });
          else if (humanTurn && game.turnPhase === LudoTurnPhase.WAITING_FOR_MOVE) {
            const tokenId = engine.getLegalTokenIds(game, 'human', game.diceValue!)[0];
            await runtime.execute({ ...base, type: 'MOVE_TOKEN', tokenId });
          } else await sleep(2); // bot's turn: the driver acts on its own
        } catch {
          await sleep(2); // raced the bot; re-read state
        }
      }

      const final = (await runtime.getStoredSnapshot('m1'))!.game;
      expect(final.phase).toBe(LudoMatchPhase.FINISHED);
      expect(final.winnerOrder.sort()).toEqual(['bot', 'human']);
      expect(published).toContain('DICE_ROLLED'); // the bot really played
      driver.onModuleDestroy();
    } finally {
      BotDriverService.delays = savedDelays;
      await cleanup();
    }
  }, 60_000);
});
