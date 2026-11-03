import { HttpException, Logger, UsePipes, ValidationPipe } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import { ChallengeService } from '../challenge/challenge.service';
import { ChallengeCommandDto, ChallengeCreateDto } from '../challenge/dto/challenge.dto';
import { ChallengeAcceptFailedError } from '../challenge/challenge.types';
import { ChatService } from '../chat/chat.service';
import { LobbyChatSendDto, MatchChatHistoryDto, MatchChatSendDto } from '../chat/dto/chat.dto';
import { LudoRuntimeCommand } from '../games/ludo/runtime';
import { LobbyCommandDto, LobbyJoinDto } from '../lobby/dto/lobby.dto';
import { LobbyService } from '../lobby/lobby.service';
import { JoinMatchmakingDto } from '../matchmaking/dto/join-matchmaking.dto';
import { ListMatchmakingDto } from '../matchmaking/dto/list-matchmaking.dto';
import { MatchmakingService } from '../matchmaking/matchmaking.service';
import { MatchJoinDto, LudoCommandDto, LudoMoveCommandDto } from './dto/ludo-command.dto';
import { LudoRuntimeService } from './ludo-runtime.service';
import { PresenceService } from './presence.service';
import { RealtimePublisherService } from './realtime-publisher.service';
import { RealtimeAuthService } from './realtime-auth.service';
import { TurnTimeoutService } from './timeout/turn-timeout.service';
import {
  AuthenticatedSocket,
  CommandAck,
  REALTIME_PROTOCOL_VERSION,
  RealtimeEnvelope,
  SnapshotAck,
} from './realtime.types';

@WebSocketGateway({ namespace: '/game' })
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly auth: RealtimeAuthService,
    private readonly presence: PresenceService,
    private readonly ludoRuntime: LudoRuntimeService,
    private readonly matchmaking: MatchmakingService,
    private readonly lobby: LobbyService,
    private readonly challenge: ChallengeService,
    private readonly chat: ChatService,
    private readonly publisher: RealtimePublisherService,
    private readonly timeouts: TurnTimeoutService,
  ) {}

  afterInit(server: Server): void {
    this.publisher.attach(server);
    this.logger.log('Realtime gateway initialized on namespace /game');
  }

  async handleConnection(socket: AuthenticatedSocket): Promise<void> {
    try {
      const user = await this.auth.authenticate(socket);
      socket.data.user = user;
      await socket.join(this.publisher.userRoom(user.id));
      await this.presence.connected(user.id, socket.id);
      await this.timeouts.onConnected(user.id);
      socket.data.presenceTimer = setInterval(() => {
        void this.presence.heartbeat(user.id, socket.id);
        void this.lobby.touch(user.id).catch(() => undefined);
      }, 30_000);
      socket.emit('session:ready', this.envelope({ userId: user.id }));
    } catch (error) {
      socket.emit('session:error', this.errorPayload(error));
      socket.disconnect(true);
    }
  }

  async handleDisconnect(socket: AuthenticatedSocket): Promise<void> {
    if (socket.data.presenceTimer) clearInterval(socket.data.presenceTimer);
    if (!socket.data.user) return;
    const becameOffline = await this.presence.disconnected(socket.data.user.id, socket.id).catch(() => false);
    if (becameOffline) {
      await this.handleLobbyDisconnect(socket.data.user.id).catch(() => undefined);
      await this.timeouts.onDisconnected(socket.data.user.id).catch(() => undefined);
    }
  }

  @SubscribeMessage('lobby:join')
  async joinLobby(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: LobbyJoinDto): Promise<any> {
    try {
      const user = this.requireUser(socket);
      const activeChallenge = await this.challenge.activeForUser(user.id);
      const activeMatch = await this.lobby.activeMatchForUser(user.id);
      if (activeMatch) {
        await this.lobby.leave(user.id).catch(() => undefined);
        return { ok: true, commandId: dto.commandId, data: { activeMatch } };
      }
      const recentMessages = await this.chat.getLobbyHistory(dto.gameModeId).catch(() => []);
      const result = await this.lobby.join(user.id, dto.gameModeId, recentMessages);
      if (result.previousGameModeId && result.previousGameModeId !== dto.gameModeId) {
        await socket.leave(this.publisher.lobbyRoom(result.previousGameModeId));
        this.server.to(this.publisher.lobbyRoom(result.previousGameModeId)).emit(
          'lobby:player_left',
          this.envelope({ gameModeId: result.previousGameModeId, player: result.player }),
        );
      }
      await socket.join(this.publisher.lobbyRoom(dto.gameModeId));
      this.server.to(this.publisher.lobbyRoom(dto.gameModeId)).emit(
        'lobby:player_joined',
        this.envelope({ gameModeId: dto.gameModeId, player: result.player }),
      );
      return { ok: true, commandId: dto.commandId, data: { ...result.snapshot, ...(activeChallenge ? { activeChallenge } : {}) } };
    } catch (error) {
      return this.errorAck(error);
    }
  }

  @SubscribeMessage('lobby:ready')
  async readyLobby(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: LobbyCommandDto): Promise<any> {
    try {
      const user = this.requireUser(socket);
      const result = await this.lobby.ready(user.id);
      this.server.to(this.publisher.lobbyRoom(result.gameModeId)).emit(
        'lobby:player_ready',
        this.envelope({ gameModeId: result.gameModeId, player: result.player }),
      );
      return { ok: true, commandId: dto.commandId };
    } catch (error) {
      return this.errorAck(error);
    }
  }

  @SubscribeMessage('lobby:unready')
  async unreadyLobby(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: LobbyCommandDto): Promise<any> {
    try {
      const user = this.requireUser(socket);
      const result = await this.lobby.unready(user.id);
      this.server.to(this.publisher.lobbyRoom(result.gameModeId)).emit(
        'lobby:player_unready',
        this.envelope({ gameModeId: result.gameModeId, player: result.player }),
      );
      return { ok: true, commandId: dto.commandId };
    } catch (error) {
      return this.errorAck(error);
    }
  }

  @SubscribeMessage('lobby:leave')
  async leaveLobby(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: LobbyCommandDto): Promise<any> {
    try {
      const user = this.requireUser(socket);
      const cancelled = await this.challenge.cancelForUser(user.id);
      if (cancelled) this.publisher.publishChallengeTransition(cancelled);
      const result = await this.lobby.leave(user.id);
      if (result.gameModeId) {
        await socket.leave(this.publisher.lobbyRoom(result.gameModeId));
        this.server.to(this.publisher.lobbyRoom(result.gameModeId)).emit(
          'lobby:player_left',
          this.envelope({ gameModeId: result.gameModeId, player: result.player }),
        );
      }
      return { ok: true, commandId: dto.commandId };
    } catch (error) {
      return this.errorAck(error);
    }
  }

  @SubscribeMessage('challenge:create')
  async createChallenge(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: ChallengeCreateDto): Promise<any> {
    try {
      const user = this.requireUser(socket);
      const result = await this.challenge.create(user.id, dto.opponentUserId, dto.commandId);
      const challenge = result.challenge;
      for (const userId of [challenge.challengerId, challenge.opponentId]) {
        this.server.to(this.publisher.lobbyRoom(challenge.gameModeId)).emit(
          'lobby:player_busy',
          this.envelope({ gameModeId: challenge.gameModeId, userId }),
        );
      }
      this.publisher.publishUser(challenge.challengerId, 'challenge:created', challenge);
      this.publisher.publishUser(challenge.opponentId, 'challenge:received', challenge);
      return { ok: true, commandId: dto.commandId, duplicate: result.duplicate };
    } catch (error) {
      return this.errorAck(error);
    }
  }

  @SubscribeMessage('lobby:chat:send')
  async sendLobbyChat(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: LobbyChatSendDto): Promise<any> {
    try {
      const user = this.requireUser(socket);
      const result = await this.chat.sendLobbyMessage(user.id, dto.commandId, dto.text);
      if (!result.duplicate) {
        this.server.to(this.publisher.lobbyRoom(result.message.scopeId)).emit('lobby:chat:message', this.envelope(result.message));
      }
      return { ok: true, commandId: dto.commandId, duplicate: result.duplicate, data: result.message };
    } catch (error) {
      return this.errorAck(error);
    }
  }

  @SubscribeMessage('challenge:accept')
  async acceptChallenge(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: ChallengeCommandDto): Promise<any> {
    try {
      const user = this.requireUser(socket);
      const result = await this.challenge.accept(user.id, dto.challengeId, dto.commandId);
      if (!result.duplicate) this.publisher.publishChallengeTransition(result);
      return { ok: true, commandId: dto.commandId, duplicate: result.duplicate, data: result.challenge };
    } catch (error) {
      if (error instanceof ChallengeAcceptFailedError) {
        this.publisher.publishChallengeTransition(error.transition);
        return this.errorAck(error.reason);
      }
      return this.errorAck(error);
    }
  }

  @SubscribeMessage('challenge:reject')
  async rejectChallenge(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: ChallengeCommandDto): Promise<any> {
    try {
      const user = this.requireUser(socket);
      const result = await this.challenge.reject(user.id, dto.challengeId, dto.commandId);
      if (!result.duplicate) this.publisher.publishChallengeTransition(result);
      return { ok: true, commandId: dto.commandId, duplicate: result.duplicate };
    } catch (error) {
      return this.errorAck(error);
    }
  }

  @SubscribeMessage('challenge:cancel')
  async cancelChallenge(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: ChallengeCommandDto): Promise<any> {
    try {
      const user = this.requireUser(socket);
      const result = await this.challenge.cancel(user.id, dto.challengeId, dto.commandId);
      if (!result.duplicate) this.publisher.publishChallengeTransition(result);
      return { ok: true, commandId: dto.commandId, duplicate: result.duplicate };
    } catch (error) {
      return this.errorAck(error);
    }
  }

  @SubscribeMessage('match:join')
  async joinMatch(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() dto: MatchJoinDto,
  ): Promise<SnapshotAck> {
    try {
      const user = this.requireUser(socket);
      const state = await this.ludoRuntime.getSnapshot(dto.matchId, user.id);
      await socket.join(this.publisher.matchRoom(dto.matchId));
      const timing = await this.timeouts.onMatchJoined(dto.matchId, user.id, state);
      const participants = await this.ludoRuntime.getParticipantViews(dto.matchId, state);
      const recentMessages = await this.chat.getMatchHistory(dto.matchId).catch(() => []);
      return { ok: true, state, timing, version: state.game.version, participants, recentMessages };
    } catch (error) {
      return this.errorAck(error);
    }
  }

  @SubscribeMessage('match:chat:send')
  async sendMatchChat(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: MatchChatSendDto): Promise<any> {
    try {
      const user = this.requireUser(socket);
      const result = await this.chat.sendMatchMessage(user.id, dto.matchId, dto.commandId, dto.text);
      if (!result.duplicate) {
        this.server.to(this.publisher.matchRoom(dto.matchId)).emit('match:chat:message', this.envelope(result.message, dto.matchId));
      }
      return { ok: true, commandId: dto.commandId, duplicate: result.duplicate, data: result.message };
    } catch (error) {
      return this.errorAck(error);
    }
  }

  @SubscribeMessage('match:chat:history')
  async matchChatHistory(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: MatchChatHistoryDto): Promise<any> {
    try {
      const user = this.requireUser(socket);
      const messages = await this.chat.getMatchHistoryForUser(user.id, dto.matchId);
      return { ok: true, messages };
    } catch (error) {
      return this.errorAck(error);
    }
  }

  @SubscribeMessage('ludo:sync')
  async sync(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() dto: MatchJoinDto,
  ): Promise<SnapshotAck> {
    try {
      const user = this.requireUser(socket);
      const state = await this.ludoRuntime.getSnapshot(dto.matchId, user.id);
      const timing = await this.timeouts.getTiming(dto.matchId, state);
      const participants = await this.ludoRuntime.getParticipantViews(dto.matchId, state);
      return { ok: true, state, timing, version: state.game.version, participants };
    } catch (error) {
      return this.errorAck(error);
    }
  }

  @SubscribeMessage('ludo:roll_for_start')
  rollForStart(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: LudoCommandDto): Promise<CommandAck> {
    return this.executeLudo(socket, dto, { type: 'ROLL_FOR_START' });
  }

  @SubscribeMessage('ludo:roll')
  roll(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: LudoCommandDto): Promise<CommandAck> {
    return this.executeLudo(socket, dto, { type: 'ROLL_DICE' });
  }

  @SubscribeMessage('ludo:move')
  move(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: LudoMoveCommandDto): Promise<CommandAck> {
    return this.executeLudo(socket, dto, { type: 'MOVE_TOKEN', tokenId: dto.tokenId });
  }

  @SubscribeMessage('ludo:resign')
  resign(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: LudoCommandDto): Promise<CommandAck> {
    return this.executeLudo(socket, dto, { type: 'RESIGN' });
  }

  @SubscribeMessage('matchmaking:join')
  async joinMatchmaking(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() dto: JoinMatchmakingDto,
  ): Promise<any> {
    try {
      const user = this.requireUser(socket);
      const result = await this.matchmaking.join(user.id, dto);
      if (result.status === 'MATCHED') {
        for (const matchedUserId of result.userIds) {
          this.publisher.publishUser(
            matchedUserId,
            'matchmaking:matched',
            { match: result.match, gameModeId: result.gameModeId },
            result.match.id,
          );
        }
      }

      const lobbyModeId = result.status === 'MATCHED' ? result.gameModeId : dto.gameModeId;
      await this.broadcastLobbyUpdate(lobbyModeId);
      return { ok: true, ...result };
    } catch (error) {
      return this.errorAck(error);
    }
  }

  @SubscribeMessage('matchmaking:list')
  async listMatchmaking(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() dto: ListMatchmakingDto,
  ): Promise<any> {
    try {
      const user = this.requireUser(socket);
      const result = await this.matchmaking.list(dto.gameModeId, user.id);
      return { ok: true, gameModeId: dto.gameModeId, ...result };
    } catch (error) {
      return this.errorAck(error);
    }
  }

  @SubscribeMessage('matchmaking:subscribe')
  async subscribeMatchmakingLobby(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() dto: ListMatchmakingDto,
  ): Promise<any> {
    try {
      const user = this.requireUser(socket);
      await socket.join(this.publisher.lobbyRoom(dto.gameModeId));
      const payload = await this.matchmaking.buildLobbyPayload(dto.gameModeId, user.id);
      return { ok: true, ...payload };
    } catch (error) {
      return this.errorAck(error);
    }
  }

  @SubscribeMessage('matchmaking:unsubscribe')
  async unsubscribeMatchmakingLobby(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() dto: ListMatchmakingDto,
  ): Promise<any> {
    try {
      await socket.leave(this.publisher.lobbyRoom(dto.gameModeId));
      return { ok: true };
    } catch (error) {
      return this.errorAck(error);
    }
  }

  @SubscribeMessage('matchmaking:cancel')
  async cancelMatchmaking(@ConnectedSocket() socket: AuthenticatedSocket): Promise<any> {
    try {
      const user = this.requireUser(socket);
      const status = await this.matchmaking.status(user.id);
      const result = await this.matchmaking.cancel(user.id);
      if (status.status === 'QUEUED' && status.gameModeId) {
        await this.broadcastLobbyUpdate(status.gameModeId);
      }
      return { ok: true, ...result };
    } catch (error) {
      return this.errorAck(error);
    }
  }

  @SubscribeMessage('matchmaking:status')
  async matchmakingStatus(@ConnectedSocket() socket: AuthenticatedSocket): Promise<any> {
    try {
      const user = this.requireUser(socket);
      return { ok: true, ...(await this.matchmaking.status(user.id)) };
    } catch (error) {
      return this.errorAck(error);
    }
  }

  private async executeLudo(
    socket: AuthenticatedSocket,
    dto: LudoCommandDto,
    commandData: { type: LudoRuntimeCommand['type']; tokenId?: string },
  ): Promise<CommandAck> {
    try {
      const user = this.requireUser(socket);
      if (!socket.rooms.has(this.publisher.matchRoom(dto.matchId))) throw new Error('MATCH_ROOM_NOT_JOINED');
      if (commandData.type === 'ROLL_FOR_START') await this.timeouts.assertAllParticipantsJoined(dto.matchId);
      const command = {
        type: commandData.type,
        commandId: dto.commandId,
        playerId: user.id,
        expectedVersion: dto.expectedVersion,
        ...(commandData.tokenId ? { tokenId: commandData.tokenId } : {}),
        matchId: dto.matchId,
      } as LudoRuntimeCommand & { matchId: string };

      const result = await this.ludoRuntime.execute(command);
      this.publisher.publishExecution(result);
      if (!result.duplicate) await this.timeouts.afterManualExecution(result.state, user.id);

      return {
        ok: true,
        commandId: dto.commandId,
        version: result.state.game.version,
        duplicate: result.duplicate,
      };
    } catch (error) {
      return this.errorAck(error);
    }
  }

  private requireUser(socket: AuthenticatedSocket) {
    if (!socket.data.user) throw new Error('SOCKET_NOT_AUTHENTICATED');
    return socket.data.user;
  }

  private envelope<T>(data: T, matchId?: string, version?: number): RealtimeEnvelope<T> {
    return {
      protocolVersion: REALTIME_PROTOCOL_VERSION,
      eventId: randomUUID(),
      serverTime: new Date().toISOString(),
      ...(matchId ? { matchId } : {}),
      ...(version !== undefined ? { version } : {}),
      data,
    };
  }

  private async broadcastLobbyUpdate(gameModeId: string): Promise<void> {
    const room = this.publisher.lobbyRoom(gameModeId);
    const sockets = await this.server.in(room).fetchSockets();
    for (const remoteSocket of sockets) {
      const socket = remoteSocket as unknown as AuthenticatedSocket;
      const userId = socket.data?.user?.id;
      const payload = await this.matchmaking.buildLobbyPayload(gameModeId, userId);
      remoteSocket.emit('matchmaking:lobby_updated', this.envelope(payload));
    }
  }

  private async handleLobbyDisconnect(userId: string): Promise<void> {
    const cancelled = await this.challenge.cancelForUser(userId);
    if (cancelled) this.publisher.publishChallengeTransition(cancelled);
    const left = await this.lobby.leave(userId);
    if (left.gameModeId) {
      this.server.to(this.publisher.lobbyRoom(left.gameModeId)).emit(
        'lobby:player_left',
        this.envelope({ gameModeId: left.gameModeId, player: left.player }),
      );
    }
  }

  private errorAck(error: unknown): any {
    const payload = this.errorPayload(error);
    return { ok: false, code: payload.code, message: payload.message };
  }

  private errorPayload(error: unknown): { code: string; message: string } {
    if (error instanceof HttpException) {
      const response = error.getResponse();
      if (typeof response === 'object' && response !== null) {
        const value = response as { code?: string; message?: string | string[] };
        return {
          code: value.code ?? 'REQUEST_FAILED',
          message: Array.isArray(value.message) ? value.message.join(', ') : value.message ?? error.message,
        };
      }
      return { code: 'REQUEST_FAILED', message: String(response) };
    }
    if (error instanceof Error) {
      const knownCode = /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'REALTIME_COMMAND_FAILED';
      return { code: knownCode, message: knownCode === error.message ? error.message : 'Realtime command failed.' };
    }
    return { code: 'REALTIME_COMMAND_FAILED', message: 'Realtime command failed.' };
  }
}
