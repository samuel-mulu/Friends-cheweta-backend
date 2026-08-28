import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { SettlementService } from '../../settlement/settlement.service';
import { TurnTimeoutService } from './turn-timeout.service';

@Injectable()
export class RealtimeMaintenanceService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RealtimeMaintenanceService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private tickCount = 0;

  constructor(
    private readonly timeouts: TurnTimeoutService,
    private readonly settlement: SettlementService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), 1000);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.timeouts.processDueTurnTimeouts();
      await this.timeouts.processDueDisconnects();
      await this.timeouts.processReadyNoShows();
      this.tickCount += 1;
      if (this.tickCount % 5 === 0) {
        await this.settlement.reconcilePending();
      }
    } catch (error) {
      this.logger.warn(`Realtime maintenance tick failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
