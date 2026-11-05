import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { MatchStatus, UserRole } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { computePlayerMatchStats, summarizePlayerStats } from './stats.compute';

export type LeaderboardPeriod = 'week' | 'all';
const LEADERBOARD_SIZE = 50;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Player statistics and leaderboard (practice games are never recorded). */
@Injectable()
export class StatsService {
  private readonly logger = new Logger(StatsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Writes per-player rows for a FINISHED non-practice match. Idempotent. */
  async recordMatch(matchId: string): Promise<number> {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: {
        status: true,
        source: true,
        winnerOrder: true,
        participants: { select: { userId: true } },
        checkpoint: { select: { state: true } },
      },
    });
    if (!match || match.status !== MatchStatus.FINISHED || match.source === 'PRACTICE') return 0;

    const events = await this.prisma.matchEvent.findMany({
      where: { matchId, type: { in: ['DICE_ROLLED', 'TOKEN_CAPTURED', 'TOKEN_FINISHED'] } },
      select: { type: true, payload: true },
      orderBy: { sequence: 'asc' },
    });
    const players =
      (
        match.checkpoint?.state as {
          game?: { players?: Array<{ userId: string; color: string }> };
        } | null
      )?.game?.players ?? [];
    const rows = computePlayerMatchStats({
      playerIds: match.participants.map((p) => p.userId),
      winnerOrder: Array.isArray(match.winnerOrder) ? (match.winnerOrder as string[]) : [],
      colorByUser: Object.fromEntries(players.map((p) => [p.userId, p.color])),
      events,
    });
    const result = await this.prisma.playerMatchStat.createMany({
      data: rows.map((row) => ({ matchId, ...row })),
      skipDuplicates: true,
    });
    this.logger.log(`stats_recorded match=${matchId} rows=${result.count}`);
    return result.count;
  }

  async playerSummary(userId: string) {
    const rows = await this.prisma.playerMatchStat.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: { won: true, rolls: true, sixes: true, captures: true, tokensHome: true },
    });
    return summarizePlayerStats(rows);
  }

  /** Top players by wins (tie-break: win rate, then games). 'week' = last 7 days. */
  async leaderboard(period: LeaderboardPeriod) {
    const where = period === 'week' ? { createdAt: { gte: new Date(Date.now() - WEEK_MS) } } : {};
    const [games, wins] = await Promise.all([
      this.prisma.playerMatchStat.groupBy({ by: ['userId'], where, _count: { _all: true } }),
      this.prisma.playerMatchStat.groupBy({
        by: ['userId'],
        where: { ...where, won: true },
        _count: { _all: true },
      }),
    ]);
    const winsBy = new Map(wins.map((row) => [row.userId, row._count._all]));
    const ranked = games
      .map((row) => {
        const w = winsBy.get(row.userId) ?? 0;
        return {
          userId: row.userId,
          games: row._count._all,
          wins: w,
          winRate: Math.round((w / row._count._all) * 1000) / 1000,
        };
      })
      .sort((a, b) => b.wins - a.wins || b.winRate - a.winRate || b.games - a.games)
      .slice(0, LEADERBOARD_SIZE);
    const users = await this.prisma.user.findMany({
      where: { id: { in: ranked.map((r) => r.userId) } },
      select: { id: true, fullName: true },
    });
    const names = new Map(users.map((u) => [u.id, u.fullName]));
    return {
      period,
      entries: ranked.map((row, index) => ({
        rank: index + 1,
        displayName: names.get(row.userId) ?? 'Player',
        ...row,
      })),
    };
  }

  /** Stats of one match, for its participants (or admins). */
  async matchStats(matchId: string, requester: { id: string; role: UserRole }) {
    const rows = await this.prisma.playerMatchStat.findMany({
      where: { matchId },
      orderBy: { position: 'asc' },
      include: { user: { select: { fullName: true } } },
    });
    if (rows.length === 0) {
      const exists = await this.prisma.match.findUnique({
        where: { id: matchId },
        select: { id: true },
      });
      if (!exists)
        throw new NotFoundException({ code: 'MATCH_NOT_FOUND', message: 'Match not found.' });
      return { matchId, players: [] }; // not recorded yet (or practice)
    }
    if (requester.role !== UserRole.ADMIN && !rows.some((row) => row.userId === requester.id)) {
      throw new ForbiddenException({
        code: 'MATCH_ACCESS_DENIED',
        message: 'You are not part of this match.',
      });
    }
    return {
      matchId,
      players: rows.map(({ user, id: _id, matchId: _m, createdAt: _c, ...row }) => ({
        ...row,
        displayName: user.fullName,
      })),
    };
  }
}
