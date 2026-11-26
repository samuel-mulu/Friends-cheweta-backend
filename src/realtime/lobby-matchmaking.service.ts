import { Injectable, Logger } from '@nestjs/common';
import { ChallengeService } from '../challenge/challenge.service';
import { ChallengeTransition } from '../challenge/challenge.types';
import { RealtimePublisherService } from './realtime-publisher.service';

/**
 * The one place request outcomes reach players, and where automatic matching
 * runs. Every path that ends or starts a request (a command, a disconnect,
 * the expiry sweep) publishes through [publish]; players it returns to READY
 * get another chance to be auto-paired, and [pair] runs when someone gets
 * ready. Pairing itself is atomic in ChallengeService.autoPair, so concurrent
 * calls (two players readying at once, a manual request racing) are safe.
 */
@Injectable()
export class LobbyMatchmakingService {
  private readonly logger = new Logger(LobbyMatchmakingService.name);

  constructor(
    private readonly challenges: ChallengeService,
    private readonly publisher: RealtimePublisherService,
  ) {}

  /** Broadcast a request outcome, then try to auto-pair the players who are ready again. */
  publish(transition: ChallengeTransition): void {
    this.publisher.publishChallengeTransition(transition);
    for (const player of transition.restoredPlayers) this.pairSoon(player.userId);
  }

  /** Auto-pair [userId] (just ready) if someone is ready at the same terms. */
  async pair(userId: string): Promise<void> {
    try {
      const transition = await this.challenges.autoPair(userId);
      if (transition) this.publish(transition);
    } catch (error) {
      this.logger.warn(`auto_pair_failed user=${userId} reason=${(error as Error).message}`);
    }
  }

  /** After the current broadcast, so clients see the READY state before a match starts. */
  private pairSoon(userId: string): void {
    setImmediate(() => void this.pair(userId));
  }
}
