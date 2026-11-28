import { Injectable, Logger } from '@nestjs/common';
import { ChallengeService } from '../challenge/challenge.service';
import { ChallengeTransition } from '../challenge/challenge.types';
import { KartaTableService } from './karta/karta-table.service';
import { RealtimePublisherService } from './realtime-publisher.service';

/**
 * The one place request outcomes reach players, and where automatic matching
 * runs. Every path that ends or starts a request (a command, a disconnect,
 * the expiry sweep) publishes through [publish]; players it returns to READY
 * get another chance to be auto-paired, and [pair] runs when someone gets
 * ready. Pairing itself is atomic in ChallengeService.autoPair, so concurrent
 * calls (two players readying at once, a manual request racing) are safe.
 *
 * Karta tables: a ready player first takes a free seat at an open table; a
 * pairing that starts a table's first round opens the table before anyone
 * hears about the match, so their screens find it.
 */
@Injectable()
export class LobbyMatchmakingService {
  private readonly logger = new Logger(LobbyMatchmakingService.name);

  constructor(
    private readonly challenges: ChallengeService,
    private readonly publisher: RealtimePublisherService,
    private readonly tables: KartaTableService,
  ) {}

  /** Broadcast a request outcome, then try to auto-pair the players who are ready again. */
  publish(transition: ChallengeTransition): void {
    const match = transition.challenge.match;
    if (transition.event === 'challenge:accepted' && match && this.tables.isTableMatch(match)) {
      void this.tables
        .open(match)
        .catch((error: Error) =>
          this.logger.warn(`table_open_failed match=${match.id} ${error.message}`),
        )
        .finally(() => this.deliver(transition));
      return;
    }
    this.deliver(transition);
  }

  /** Seat [userId] (just ready) at a Karta table, else auto-pair them. */
  async pair(userId: string): Promise<void> {
    try {
      if (await this.tables.seatReady(userId)) return;
      const transition = await this.challenges.autoPair(userId);
      if (transition) this.publish(transition);
    } catch (error) {
      this.logger.warn(`auto_pair_failed user=${userId} reason=${(error as Error).message}`);
    }
  }

  private deliver(transition: ChallengeTransition): void {
    this.publisher.publishChallengeTransition(transition);
    for (const player of transition.restoredPlayers) this.pairSoon(player.userId);
  }

  /** After the current broadcast, so clients see the READY state before a match starts. */
  private pairSoon(userId: string): void {
    setImmediate(() => void this.pair(userId));
  }
}
