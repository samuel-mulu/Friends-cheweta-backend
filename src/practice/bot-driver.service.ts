import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { LudoMatchPhase, LudoTurnPhase } from '../games/ludo/domain';
import { LudoEngine } from '../games/ludo/engine';
import { LudoMatchRuntimeState, LudoRuntimeCommand } from '../games/ludo/runtime';
import { PrismaService } from '../prisma/prisma.service';
import { LudoRuntimeService } from '../realtime/ludo-runtime.service';
import { RealtimePublisherService } from '../realtime/realtime-publisher.service';
import { TurnTimeoutService } from '../realtime/timeout/turn-timeout.service';
import { BotLevelCache } from './bot-levels';
import { PracticeLevel, practiceBot } from './practice.constants';

export type BotAction = {
  playerId: string;
  type: 'ROLL_FOR_START' | 'ROLL_DICE' | 'MOVE_TOKEN';
  tokenId?: string;
};

const engine = new LudoEngine();

/** Pure: which bot (if any) should act now, and how. */
export function decideBotAction(
  state: LudoMatchRuntimeState,
  botLevels: ReadonlyMap<string, PracticeLevel>,
): BotAction | null {
  const game = state.game;
  if (game.phase === LudoMatchPhase.PRE_GAME && game.turnPhase === LudoTurnPhase.START_ROLL) {
    const bot = state.startingRoll.candidatePlayerIds.find(
      (id) => botLevels.has(id) && state.startingRoll.rolls[id] === undefined,
    );
    return bot ? { playerId: bot, type: 'ROLL_FOR_START' } : null;
  }
  if (game.phase !== LudoMatchPhase.PLAYING || !game.currentPlayerId) return null;
  const level = botLevels.get(game.currentPlayerId);
  if (!level) return null;
  if (game.turnPhase === LudoTurnPhase.WAITING_FOR_ROLL)
    return { playerId: game.currentPlayerId, type: 'ROLL_DICE' };
  if (game.turnPhase === LudoTurnPhase.WAITING_FOR_MOVE && game.diceValue !== null) {
    const legal = engine.getLegalMoves(game, game.currentPlayerId, game.diceValue);
    if (legal.length === 0) return null;
    const choice = practiceBot(level, game.version + 1).chooseMove(
      game,
      game.currentPlayerId,
      game.diceValue,
      legal,
    );
    return { playerId: game.currentPlayerId, type: 'MOVE_TOKEN', tokenId: choice.tokenId };
  }
  return null;
}

/**
 * Plays bot turns in practice matches through the normal authoritative
 * runtime (same validation, events, timers and persistence as a person).
 * Reacts to every committed command and to a player joining; turn timeouts
 * remain the safety net if a scheduled bot action is lost (e.g. restart).
 */
@Injectable()
export class BotDriverService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotDriverService.name);
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly bots: BotLevelCache;
  private unsubscribe?: () => void;

  /** Pause before a bot acts, so people can follow (and animations finish). */
  static delays = { ROLL_FOR_START: 700, ROLL_DICE: 900, MOVE_TOKEN: 1000 };

  constructor(
    prisma: PrismaService,
    private readonly runtime: LudoRuntimeService,
    private readonly publisher: RealtimePublisherService,
    private readonly timeouts: TurnTimeoutService,
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

  /** Schedule the next bot action for this match, if one is due. */
  async consider(state: LudoMatchRuntimeState): Promise<void> {
    const matchId = state.game.matchId;
    if (this.timers.has(matchId)) return; // already scheduled; it re-decides when it fires
    const levels = await this.botLevels(state);
    if (levels.size === 0) return;
    const action = decideBotAction(state, levels);
    if (!action) return;
    this.timers.set(
      matchId,
      setTimeout(() => void this.act(matchId), BotDriverService.delays[action.type]),
    );
  }

  private async act(matchId: string): Promise<void> {
    this.timers.delete(matchId);
    try {
      const state = await this.runtime.getStoredSnapshot(matchId);
      if (!state) return;
      const action = decideBotAction(state, await this.botLevels(state));
      if (!action) return;
      const command = {
        matchId,
        type: action.type,
        playerId: action.playerId,
        commandId: `bot:${matchId}:${state.game.version}:${action.type}`,
        expectedVersion: state.game.version,
        ...(action.tokenId ? { tokenId: action.tokenId } : {}),
      } as LudoRuntimeCommand & { matchId: string };
      const result = await this.runtime.execute(command);
      this.publisher.publishExecution(result);
      await this.timeouts.afterManualExecution(result.state, action.playerId);
    } catch (error) {
      // Usually a race with the player or a timeout (version conflict); the
      // next committed command or the turn timer brings the bot back.
      this.logger.warn(`bot_action_failed match=${matchId} reason=${(error as Error).message}`);
    }
  }

  private botLevels(state: LudoMatchRuntimeState): Promise<Map<string, PracticeLevel>> {
    return this.bots.levels(state.game.players.map((player) => player.userId));
  }
}
