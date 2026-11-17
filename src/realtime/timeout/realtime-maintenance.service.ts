import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ChallengeService } from '../../challenge/challenge.service';
import { SettlementService } from '../../settlement/settlement.service';
import { RealtimePublisherService } from '../realtime-publisher.service';
import { GameRegistry } from '../turn-game/game-registry';
import { DisconnectGraceService } from './disconnect-grace.service';
import { PrematchCleanupService } from './prematch-cleanup.service';

// Gameplay maintenance (turn timeouts, disconnect grace, ready no-shows) and
// settlement reconciliation run on independent timers with independent
// guards, so a slow or stuck settlement pass can never starve time-critical
// gameplay processing.
const GAMEPLAY_TICK_MS = 1000;
const RECONCILIATION_TICK_MS = 5000;

@Injectable()
export class RealtimeMaintenanceService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RealtimeMaintenanceService.name);
  private gameplayTimer?: NodeJS.Timeout;
  private reconciliationTimer?: NodeJS.Timeout;
  private gameplayRunning = false;
  private settlementRunning = false;

  constructor(
    private readonly games: GameRegistry,
    private readonly challenges: ChallengeService,
    private readonly settlement: SettlementService,
    private readonly publisher: RealtimePublisherService,
    private readonly disconnects: DisconnectGraceService,
    private readonly prematch: PrematchCleanupService,
  ) {}

  onModuleInit(): void {
    this.gameplayTimer = setInterval(() => void this.tickGameplay(), GAMEPLAY_TICK_MS);
    this.reconciliationTimer = setInterval(() => void this.tickReconciliation(), RECONCILIATION_TICK_MS);
  }

  onApplicationShutdown(): void {
    if (this.gameplayTimer) clearInterval(this.gameplayTimer);
    if (this.reconciliationTimer) clearInterval(this.reconciliationTimer);
  }

  private async tickGameplay(): Promise<void> {
    if (this.gameplayRunning) return;
    this.gameplayRunning = true;
    try {
      const transitions = await this.challenges.sweep().catch((error: Error) => {
        this.logger.warn(`Challenge sweep failed: ${error.message}`);
        return [];
      });
      for (const transition of transitions) this.publisher.publishChallengeTransition(transition);
      for (const game of this.games.all()) await game.timer.processDue();
      await this.disconnects.processDue();
      await this.prematch.processReadyNoShows();
      await this.prematch.processPrematchOrphans();
      for (const game of this.games.all()) await game.runtime.retryPostCommit();
    } catch (error) {
      this.logger.warn(`Gameplay maintenance tick failed: ${(error as Error).message}`);
    } finally {
      this.gameplayRunning = false;
    }
  }

  private async tickReconciliation(): Promise<void> {
    if (this.settlementRunning) return;
    this.settlementRunning = true;
    try {
      await this.settlement.reconcilePending();
    } catch (error) {
      this.logger.warn(`Settlement reconciliation tick failed: ${(error as Error).message}`);
    } finally {
      this.settlementRunning = false;
    }
  }
}
