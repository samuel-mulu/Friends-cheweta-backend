import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import { ChallengeTransition } from '../challenge/challenge.types';
import { RuntimeExecution, REALTIME_PROTOCOL_VERSION } from './realtime.types';

export const LUDO_EVENT_NAMES: Record<string, string> = {
  STARTING_ROLL: 'ludo:starting_roll',
  STARTING_ROLL_TIE: 'ludo:starting_roll_tie',
  MATCH_STARTED: 'match:started',
  TURN_STARTED: 'ludo:turn_started',
  DICE_ROLLED: 'ludo:dice_rolled',
  LEGAL_MOVES_READY: 'ludo:legal_moves_ready',
  NO_LEGAL_MOVE: 'ludo:no_legal_move',
  THIRD_SIX_FORFEITED: 'ludo:third_six_forfeited',
  TOKEN_MOVED: 'ludo:token_moved',
  TOKEN_CAPTURED: 'ludo:token_captured',
  TOKEN_FINISHED: 'ludo:token_finished',
  EXTRA_ROLL_GRANTED: 'ludo:extra_roll_granted',
  PLAYER_FINISHED: 'ludo:player_finished',
  PLAYER_RESIGNED: 'ludo:player_resigned',
  MATCH_FINISHED: 'match:finished',
};

@Injectable()
export class RealtimePublisherService {
  private server?: Server;

  attach(server: Server): void {
    this.server = server;
  }

  publishExecution(result: RuntimeExecution): void {
    if (!this.server || result.duplicate) return;
    for (const event of result.events) {
      const eventName = LUDO_EVENT_NAMES[event.type] ?? 'ludo:event';
      this.server.to(this.matchRoom(event.matchId)).emit(eventName, {
        protocolVersion: REALTIME_PROTOCOL_VERSION,
        eventId: randomUUID(),
        serverTime: new Date().toISOString(),
        matchId: event.matchId,
        version: event.version,
        data: event,
      });
    }
  }

  publishUser(userId: string, eventName: string, data: unknown, matchId?: string): void {
    this.publishRoom(this.userRoom(userId), eventName, data, matchId);
  }

  publishRoom(room: string, eventName: string, data: unknown, matchId?: string): void {
    if (!this.server) return;
    this.server.to(room).emit(eventName, {
      protocolVersion: REALTIME_PROTOCOL_VERSION,
      eventId: randomUUID(),
      serverTime: new Date().toISOString(),
      ...(matchId ? { matchId } : {}),
      data,
    });
  }

  /** Single broadcast path for every challenge outcome (user command, disconnect, sweep). */
  publishChallengeTransition(transition: ChallengeTransition): void {
    const { challenge, event } = transition;
    const room = this.lobbyRoom(challenge.gameModeId);
    for (const userId of new Set([challenge.challengerId, challenge.opponentId])) {
      if (userId) this.publishUser(userId, event, challenge);
    }
    for (const player of transition.restoredPlayers) {
      this.publishRoom(room, 'lobby:player_available', {
        gameModeId: challenge.gameModeId,
        player,
      });
    }
    for (const userId of transition.leftUserIds) {
      this.publishRoom(room, 'lobby:player_left', {
        gameModeId: challenge.gameModeId,
        player: { userId },
      });
    }
    for (const { userId, match } of transition.matchReady) {
      this.publishUser(userId, 'match:ready', { match }, match.id);
    }
  }

  lobbyRoom(gameModeId: string): string {
    return `lobby:${gameModeId}`;
  }

  userRoom(userId: string): string {
    return `user:${userId}`;
  }

  matchRoom(matchId: string): string {
    return `match:${matchId}`;
  }
}
