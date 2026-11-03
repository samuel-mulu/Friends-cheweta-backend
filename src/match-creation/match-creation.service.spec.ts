import { Prisma } from '../generated/prisma/client';
import { MatchCreationService } from './match-creation.service';

const prismaError = (code: string, target?: string) =>
  new Prisma.PrismaClientKnownRequestError('db error', {
    code,
    clientVersion: 'test',
    meta: target ? { target: [target] } : undefined,
  });

describe('MatchCreationService retries', () => {
  function createHarness() {
    const existingByChallenge = new Map<string, any>();
    const prisma = {
      match: {
        findUnique: jest.fn(
          async ({ where }: any) => existingByChallenge.get(where.challengeId) ?? null,
        ),
      },
      $transaction: jest.fn(),
    };
    const service = new MatchCreationService(prisma as any, {} as any);
    return { service, prisma, existingByChallenge };
  }
  const input = {
    gameModeId: 'm',
    playerIds: ['A', 'B'] as [string, string],
    challengeId: 'c1',
    source: 'CHALLENGE' as const,
  };
  const created = {
    id: 'match-1',
    stakeAmountMinor: 0n,
    gameMode: { stakeAmountMinor: 0n },
    entries: [],
  };

  it('retries a serialization failure (P2034) and succeeds', async () => {
    const { service, prisma } = createHarness();
    prisma.$transaction.mockRejectedValueOnce(prismaError('P2034')).mockResolvedValueOnce(created);

    await expect(service.createSecuredMatch(input)).resolves.toBe(created);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('returns the existing match when a concurrent create won the challengeId unique constraint', async () => {
    const { service, prisma, existingByChallenge } = createHarness();
    prisma.$transaction.mockImplementationOnce(async () => {
      existingByChallenge.set('c1', created);
      throw prismaError('P2002', 'challengeId');
    });

    const result = await service.createSecuredMatch(input);
    expect(result.id).toBe('match-1');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('gives up after repeated serialization failures', async () => {
    const { service, prisma } = createHarness();
    prisma.$transaction.mockRejectedValue(prismaError('P2034'));
    await expect(service.createSecuredMatch(input)).rejects.toBeDefined();
    expect(prisma.$transaction).toHaveBeenCalledTimes(5);
  });
});
