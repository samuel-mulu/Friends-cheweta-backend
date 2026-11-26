import { Injectable, Logger, OnApplicationShutdown, OnModuleInit, Optional } from '@nestjs/common';
import { ChallengeService } from '../../challenge/challenge.service';
import { MatchHistoryService } from '../../match-history/match-history.service';
import { SettlementService } from '../../settlement/settlement.service';
import { LobbyMatchmakingService } from '../lobby-matchmaking.service';
import { RealtimePublisherService } from '../realtime-publisher.service';
import { GameRegistry } from '../turn-game/game-registry';
import { DisconnectGraceService } from './disconnect-grace.service';
import { PrematchCleanupService } from './prematch-cleanup.service';

// Three independent loops, each with its own guard, so slow work never delays
// the clocks players can see:
//  - gameplay (1 s, Redis only): challenge expiry, turn timeouts, disconnect grace
//  - cleanup (15 s, PostgreSQL): ready no-shows, abandoned matches, post-commit retries
//  - reconciliation (5 s): pending settlements
const GAMEPLAY_TICK_MS = 1000;
const CLEANUP_TICK_MS = 15_000;
const RECONCILIATION_TICK_MS = 5000;
const EVENT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

@Injectable()
export class RealtimeMaintenanceService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RealtimeMaintenanceService.name);
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly running = new Set<string>();
  private lastEventPruneAt = 0;

  constructor(
    private readonly games: GameRegistry,
    private readonly challenges: ChallengeService,
    private readonly settlement: SettlementService,
    private readonly publisher: RealtimePublisherService,
    private readonly disconnects: DisconnectGraceService,
    private readonly prematch: PrematchCleanupService,
    private readonly history: MatchHistoryService,
    /** Broadcasts sweep outcomes and re-pairs players returned to READY. */
    @Optional() private readonly matchmaking?: LobbyMatchmakingService,
  ) {}

  onModuleInit(): void {
    this.every(GAMEPLAY_TICK_MS, 'Gameplay maintenance', () => this.tickGameplay());
    this.every(CLEANUP_TICK_MS, 'Match cleanup', () => this.tickCleanup());
    this.every(RECONCILIATION_TICK_MS, 'Settlement reconciliation', () =>
      this.settlement.reconcilePending(),
    );
  }

  onApplicationShutdown(): void {
    for (const timer of this.timers) clearInterval(timer);
  }

  /** Run `tick` on an interval; a tick still running is never re-entered. */
  private every(intervalMs: number, name: string, tick: () => Promise<void>): void {
    this.timers.push(
      setInterval(() => {
        if (this.running.has(name)) return;
        this.running.add(name);
        tick()
          .catch((error: Error) => this.logger.warn(`${name} tick failed: ${error.message}`))
          .finally(() => this.running.delete(name));
      }, intervalMs),
    );
  }

  private async tickGameplay(): Promise<void> {
    const transitions = await this.challenges.sweep().catch((error: Error) => {
      this.logger.warn(`Challenge sweep failed: ${error.message}`);
      return [];
    });
    for (const transition of transitions) {
      if (this.matchmaking) this.matchmaking.publish(transition);
      else this.publisher.publishChallengeTransition(transition);
    }
    for (const game of this.games.all()) await game.timer.processDue();
    await this.disconnects.processDue();
  }

  private async tickCleanup(): Promise<void> {
    await this.prematch.processReadyNoShows();
    await this.prematch.processPrematchOrphans();
    for (const game of this.games.all()) await game.runtime.retryPostCommit();
    await this.pruneOldEvents();
  }

  /** Once an hour: drop move-by-move history of matches closed long ago. */
  private async pruneOldEvents(): Promise<void> {
    if (Date.now() - this.lastEventPruneAt < EVENT_PRUNE_INTERVAL_MS) return;
    this.lastEventPruneAt = Date.now();
    const deleted = await this.history.pruneEvents();
    if (deleted > 0) this.logger.log(`match_events_pruned rows=${deleted}`);
  }
}
