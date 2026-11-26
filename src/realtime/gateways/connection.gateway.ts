import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
} from '@nestjs/websockets';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import { ChallengeService } from '../../challenge/challenge.service';
import { SOCKET_EVENTS_PER_SECOND } from '../../common/rate-limit';
import { LobbyService } from '../../lobby/lobby.service';
import { PresenceService } from '../presence.service';
import { RealtimeAuthService } from '../realtime-auth.service';
import { PLAYER_COMMUNICATIONS_ROOM, RealtimePublisherService } from '../realtime-publisher.service';
import { AuthenticatedSocket, REALTIME_PROTOCOL_VERSION } from '../realtime.types';
import { DisconnectGraceService } from '../timeout/disconnect-grace.service';
import { toErrorPayload } from '../ws-errors';
import { socketRateLimiter } from './socket-rate-limit';

/**
 * The socket's life on the `/game` namespace: authentication, presence
 * heartbeat, and what a lost connection means for the lobby and live matches.
 * Commands live in the other gateways on the same namespace.
 */
@WebSocketGateway({ namespace: '/game' })
export class ConnectionGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(ConnectionGateway.name);

  constructor(
    private readonly auth: RealtimeAuthService,
    private readonly presence: PresenceService,
    private readonly lobby: LobbyService,
    private readonly challenge: ChallengeService,
    private readonly publisher: RealtimePublisherService,
    private readonly disconnects: DisconnectGraceService,
  ) {}

  afterInit(server: Server): void {
    this.publisher.attach(server);
    this.logger.log('Realtime gateway initialized on namespace /game');
  }

  async handleConnection(socket: AuthenticatedSocket): Promise<void> {
    socket.use(socketRateLimiter(SOCKET_EVENTS_PER_SECOND));
    try {
      const user = await this.auth.authenticate(socket);
      socket.data.user = user;
      await socket.join(this.publisher.userRoom(user.id));
      if (user.role === 'PLAYER' && !user.isBot) await socket.join(PLAYER_COMMUNICATIONS_ROOM);
      await this.presence.connected(user.id, socket.id);
      await this.disconnects.onConnected(user.id);
      socket.data.presenceTimer = setInterval(() => {
        void this.presence.heartbeat(user.id, socket.id);
        void this.lobby.touch(user.id).catch(() => undefined);
      }, 30_000);
      socket.emit('session:ready', {
        protocolVersion: REALTIME_PROTOCOL_VERSION,
        eventId: randomUUID(),
        serverTime: new Date().toISOString(),
        data: { userId: user.id },
      });
    } catch (error) {
      socket.emit('session:error', toErrorPayload(error));
      socket.disconnect(true);
    }
  }

  async handleDisconnect(socket: AuthenticatedSocket): Promise<void> {
    if (socket.data.presenceTimer) clearInterval(socket.data.presenceTimer);
    if (!socket.data.user) return;
    const userId = socket.data.user.id;
    const becameOffline = await this.presence.disconnected(userId, socket.id).catch(() => false);
    if (becameOffline) {
      await this.leaveLobby(userId).catch(() => undefined);
      await this.disconnects.onDisconnected(userId).catch(() => undefined);
    }
  }

  private async leaveLobby(userId: string): Promise<void> {
    const cancelled = await this.challenge.cancelForUser(userId);
    if (cancelled) this.publisher.publishChallengeTransition(cancelled);
    const left = await this.lobby.leave(userId);
    if (left.gameModeId) {
      this.publisher.publishLobby(left.gameModeId, 'lobby:player_left', { player: left.player });
    }
  }
}
