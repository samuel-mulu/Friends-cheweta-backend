import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DamaMove, DamaPhase } from '../games/dama/domain';
import { DamaMatchRuntimeState, colorOfPlayer, currentLegalMoves } from '../games/dama/runtime';
import { damaBotFor } from '../games/dama/simulation';
import { PrismaService } from '../prisma/prisma.service';
import { DamaRuntimeService } from '../realtime/dama/dama-runtime.service';
import { DamaTurnTimerService } from '../realtime/dama/dama-turn-timer.service';
import { RealtimePublisherService } from '../realtime/realtime-publisher.service';
import { BotLevelCache } from './bot-levels';
import { PracticeLevel } from './practice.constants';

/** Pure: the bot's move when it is a bot's turn, else null. */
export function decideDamaBotMove(
  state: DamaMatchRuntimeState,
  botLevels: ReadonlyMap<string, PracticeLevel>,
): { playerId: string; move: DamaMove } | null {
  const { game } = state;
  if (game.phase !== DamaPhase.PLAYING || !game.currentPlayerId) return null;
  const level = botLevels.get(game.currentPlayerId);
  if (!level) return null;
  const moves = currentLegalMoves(state);
  if (moves.length === 0) return null;
  const bot = damaBotFor(level, game.version + 1);
  return { playerId: game.currentPlayerId, move: bot.choose(game, colorOfPlayer(game, game.currentPlayerId), moves) };
}

/**
 * Plays the bot's moves in Dama practice through the normal runtime (same
 * validation, events, clock and persistence as a person). The turn clock is
 * the safety net if a scheduled move is lost (e.g. a restart).
 */
@Injectable()
export class DamaBotDriverService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DamaBotDriverService.name);
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly bots: BotLevelCache;
  private unsubscribe?: () => void;

  /** Pause before the bot moves, so the person can follow (and animations finish). */
  static thinkMs = 900;

  constructor(
    prisma: PrismaService,
    private readonly runtime: DamaRuntimeService,
    private readonly publisher: RealtimePublisherService,
    private readonly timer: DamaTurnTimerService,
  ) {
    this.bots = new BotLevelCache(prisma);
  }

  onModuleInit(): void {
    this.unsubscribe = this.runtime.onExecuted((state) => void this.consider(state));
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  async consider(state: DamaMatchRuntimeState): Promise<void> {
    const matchId = state.game.matchId;
    if (this.timers.has(matchId) || state.game.phase !== DamaPhase.PLAYING) return;
    const levels = await this.bots.levels(state.game.players.map((player) => player.userId));
    if (!state.game.currentPlayerId || !levels.has(state.game.currentPlayerId)) return;
    this.timers.set(matchId, setTimeout(() => void this.act(matchId), DamaBotDriverService.thinkMs));
  }

  private async act(matchId: string): Promise<void> {
    this.timers.delete(matchId);
    try {
      const state = await this.runtime.getStoredSnapshot(matchId);
      if (!state) return;
      const decision = decideDamaBotMove(state, await this.bots.levels(state.game.players.map((player) => player.userId)));
      if (!decision) return;
      const result = await this.runtime.execute({
        matchId,
        type: 'MOVE',
        playerId: decision.playerId,
        commandId: `bot:${matchId}:${state.game.version}`,
        expectedVersion: state.game.version,
        path: decision.move.path,
      });
      this.publisher.publishDamaExecution(result);
      await this.timer.afterCommand(result.state, decision.playerId);
    } catch (error) {
      // Usually a race with the player's resign or a timeout; the next command brings the bot back.
      this.logger.warn(`dama_bot_failed match=${matchId} reason=${(error as Error).message}`);
    }
  }
}
