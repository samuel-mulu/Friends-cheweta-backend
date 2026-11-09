import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { COMMITTED_MATCH_STATUSES } from '../common/match-status';
import { normalizeEthiopianPhone } from '../common/utils/phone.util';
import { Prisma } from '../generated/prisma/client';
import { MatchEntryStatus, MatchStatus, UserStatus } from '../generated/prisma/enums';
import { generateSessionCode } from '../match-creation/match-creation.service';
import { PrismaService } from '../prisma/prisma.service';
import { TurnTimeoutService } from '../realtime/timeout/turn-timeout.service';
import { RedisService } from '../redis/redis.service';
import {
  PRACTICE_BOTS,
  PRACTICE_RULES_VERSION,
  PRACTICE_SOURCE,
  PracticeGame,
  PracticeLevel,
} from './practice.constants';

export type PracticeStartResult = {
  matchId: string;
  /** Which game screen to open (LUDO | DAMA). */
  gameCode: string;
  sessionCode: string | null;
  level: PracticeLevel | null;
  resumed: boolean;
};

const COMMAND_TTL_SECONDS = 300;

/**
 * Free practice against a bot. The match is an ordinary Ludo match (same
 * runtime, timers and recovery) with stake 0 and source PRACTICE; the bot's
 * turns are played by BotDriverService.
 */
@Injectable()
export class PracticeService {
  private readonly logger = new Logger(PracticeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly timeouts: TurnTimeoutService,
  ) {}

  async start(
    userId: string,
    level: PracticeLevel,
    commandId: string,
    tokensToWin = 4,
    game: PracticeGame = 'LUDO',
  ): Promise<PracticeStartResult> {
    const commandKey = this.redis.key('practice', 'cmd', userId, commandId);
    const previous = await this.redis.getJson<PracticeStartResult>(commandKey);
    if (previous) return previous;

    // One start at a time per player, so a double tap cannot create two matches.
    return this.redis.withLock(
      this.redis.key('lock', 'practice', userId),
      async () => {
        const user = await this.prisma.user.findUnique({
          where: { id: userId },
          select: { status: true, isBot: true },
        });
        if (!user || user.status !== UserStatus.ACTIVE || user.isBot) {
          throw new ForbiddenException({
            code: 'PLAYER_NOT_ELIGIBLE',
            message: 'Player is not eligible.',
          });
        }

        const committed = await this.prisma.matchParticipant.findFirst({
          where: { userId, match: { status: { in: COMMITTED_MATCH_STATUSES } } },
          select: { match: { select: { id: true, sessionCode: true, source: true, game: { select: { code: true } } } } },
        });
        if (committed) {
          // Already in a practice game: go back to it instead of failing.
          if (committed.match.source === PRACTICE_SOURCE) {
            return {
              matchId: committed.match.id,
              gameCode: committed.match.game.code,
              sessionCode: committed.match.sessionCode,
              level: null,
              resumed: true,
            };
          }
          throw new ConflictException({
            code: 'LOBBY_ACTIVE_MATCH',
            message: 'Finish your current match first.',
          });
        }

        const bot = await this.prisma.user.findUnique({
          where: { phoneNumber: normalizeEthiopianPhone(PRACTICE_BOTS[level].phone) },
          select: { id: true, isBot: true },
        });
        const mode = await this.prisma.gameMode.findFirst({
          where: { enabled: true, playerCount: 2, game: { code: game, enabled: true } },
          orderBy: { stakeAmountMinor: 'asc' },
          select: { id: true, gameId: true, rulesVersion: true },
        });
        if (!bot?.isBot || !mode) {
          throw new ServiceUnavailableException({
            code: 'PRACTICE_UNAVAILABLE',
            message: 'Practice is not set up yet (run the seed).',
          });
        }

        // Ludo practice always uses the current rules; Dama uses its mode's.
        const rulesVersion = game === 'LUDO' ? PRACTICE_RULES_VERSION : mode.rulesVersion;
        const match = await this.createMatch(userId, bot.id, mode, rulesVersion, tokensToWin);
        await this.timeouts.markJoined(match.id, bot.id);
        const result: PracticeStartResult = {
          matchId: match.id,
          gameCode: game,
          sessionCode: match.sessionCode,
          level,
          resumed: false,
        };
        await this.redis.setJson(commandKey, result, COMMAND_TTL_SECONDS);
        this.logger.log(`practice_started user=${userId} game=${game} level=${level} match=${match.id}`);
        return result;
      },
      undefined,
      2000,
    );
  }

  private async createMatch(
    userId: string,
    botId: string,
    mode: { id: string; gameId: string },
    rulesVersion: string,
    tokensToWin: number,
  ) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.match.create({
          data: {
            gameId: mode.gameId,
            gameModeId: mode.id,
            status: MatchStatus.READY,
            rulesVersion,
            tokensToWin,
            stakeAmountMinor: 0n,
            platformFeeBps: 0,
            sessionCode: generateSessionCode(),
            source: PRACTICE_SOURCE,
            entrySecuredAt: new Date(),
            participants: {
              create: [
                { userId, seat: 0 },
                { userId: botId, seat: 1 },
              ],
            },
            // Zero-amount entries keep settlement's invariants identical to paid games.
            entries: {
              create: [userId, botId].map((id) => ({
                userId: id,
                amountMinor: 0n,
                status: MatchEntryStatus.LOCKED,
              })),
            },
          },
          select: { id: true, sessionCode: true },
        });
      } catch (error) {
        const sessionCodeTaken =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002' &&
          String(error.meta?.target ?? '').includes('sessionCode');
        if (!sessionCodeTaken || attempt === 2) throw error;
      }
    }
    throw new ConflictException({
      code: 'PRACTICE_START_FAILED',
      message: 'Could not start practice. Try again.',
    });
  }
}
