import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ChallengeService } from '../../challenge/challenge.service';
import { SettlementService } from '../../settlement/settlement.service';
import { LudoRuntimeService } from '../ludo-runtime.service';
import { RealtimePublisherService } from '../realtime-publisher.service';
import { DamaRuntimeService } from '../dama/dama-runtime.service';
import { DamaTurnTimerService } from '../dama/dama-turn-timer.service';
import { TurnTimeoutService } from './turn-timeout.service';

// DB5: gameplay maintenance (turn timeouts, disconnect grace, ready
// no-shows) and settlement reconciliation used to share one 1-second tick
// and one `running` guard - a slow/stuck settlement reconciliation pass
// could starve time-critical gameplay processing for as long as it ran.
// They now run on fully independent timers with independent guards, so one
// can never block the other.
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
    private readonly timeouts: TurnTimeoutService,
    private readonly settlement: SettlementService,
    private readonly challenges: ChallengeService,
    private readonly publisher: RealtimePublisherService,
    private readonly runtime: LudoRuntimeService,
    private readonly damaTimer: DamaTurnTimerService,
    private readonly damaRuntime: DamaRuntimeService,
  ) {}

  onModuleInit(): void {
    this.gameplayTimer = setInterval(() => void this.tickGameplay(), GAMEPLAY_TICK_MS);
    this.reconciliationTimer = setInterval(
      () => void this.tickReconciliation(),
      RECONCILIATION_TICK_MS,
    );
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
      await this.timeouts.processDueTurnTimeouts();
      await this.damaTimer.processDue();
      await this.timeouts.processDueDisconnects();
      await this.timeouts.processReadyNoShows();
      await this.timeouts.processPrematchOrphans();
      await this.runtime.retryPostCommit();
      await this.damaRuntime.retryPostCommit();
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
