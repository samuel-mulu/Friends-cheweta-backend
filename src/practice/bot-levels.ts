import { normalizeEthiopianPhone } from '../common/utils/phone.util';
import { PrismaService } from '../prisma/prisma.service';
import { PRACTICE_BOTS, PracticeLevel } from './practice.constants';

/**
 * userId → practice level for bot accounts (people map to nothing). Bots are
 * fixed seeded accounts, so each id is looked up once per process.
 */
export class BotLevelCache {
  private readonly known = new Map<string, PracticeLevel | null>();
  private readonly levelByPhone = new Map(
    (Object.entries(PRACTICE_BOTS) as Array<[PracticeLevel, { phone: string }]>).map(([level, bot]) => [
      normalizeEthiopianPhone(bot.phone),
      level,
    ]),
  );

  constructor(private readonly prisma: PrismaService) {}

  async levels(userIds: string[]): Promise<Map<string, PracticeLevel>> {
    const unknown = userIds.filter((id) => !this.known.has(id));
    if (unknown.length > 0) {
      const users = await this.prisma.user.findMany({
        where: { id: { in: unknown } },
        select: { id: true, isBot: true, phoneNumber: true },
      });
      for (const id of unknown) {
        const user = users.find((candidate) => candidate.id === id);
        this.known.set(id, user?.isBot ? (this.levelByPhone.get(user.phoneNumber) ?? 'NORMAL') : null);
      }
    }
    const levels = new Map<string, PracticeLevel>();
    for (const id of userIds) {
      const level = this.known.get(id);
      if (level) levels.set(id, level);
    }
    return levels;
  }
}
