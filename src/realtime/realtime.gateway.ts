import { ForbiddenException, HttpException, Logger, UsePipes, ValidationPipe } from '@nestjs/common';
import { UserRole } from '../generated/prisma/enums';
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
import {
  ChallengeCommandDto,
  ChallengeCreateDto,
  ChallengeRematchDto,
  InviteCreateDto,
  InviteJoinDto,
} from '../challenge/dto/challenge.dto';
import { ChallengeAcceptFailedError } from '../challenge/challenge.types';
import { ChatService } from '../chat/chat.service';
import { DirectChatService } from '../chat/direct-chat.service';
import { BotDriverService } from '../practice/bot-driver.service';
import { PracticeStartDto } from '../practice/dto/practice.dto';
import { PracticeService } from '../practice/practice.service';
import {
  DirectChatPeerDto,
  DirectChatSendDto,
  LobbyChatSendDto,
  MatchChatHistoryDto,
  MatchReactionDto,
  MatchChatSendDto,
} from '../chat/dto/chat.dto';
import { LudoRuntimeCommand } from '../games/ludo/runtime';
import { LobbyCommandDto, LobbyJoinDto } from '../lobby/dto/lobby.dto';
import { LobbyService } from '../lobby/lobby.service';
import { MatchJoinDto, LudoCommandDto, LudoMoveCommandDto } from './dto/ludo-command.dto';
import { LudoRuntimeService } from './ludo-runtime.service';
import { PresenceService } from './presence.service';
import { ADMIN_OPERATIONS_ROOM, RealtimePublisherService } from './realtime-publisher.service';
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
    private readonly lobby: LobbyService,
    private readonly challenge: ChallengeService,
    private readonly chat: ChatService,
    private readonly directChat: DirectChatService,
    private readonly practice: PracticeService,
    private readonly botDriver: BotDriverService,
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

  @SubscribeMessage('challenge:rematch')
  async requestRematch(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: ChallengeRematchDto): Promise<any> {
    try {
      const user = this.requireUser(socket);
      const { challenge, duplicate } = await this.challenge.createRematch(user.id, dto.matchId, dto.commandId);
      if (!duplicate) {
        this.publisher.publishUser(challenge.challengerId, 'challenge:created', challenge);
        this.publisher.publishUser(challenge.opponentId, 'challenge:received', challenge);
      }
      return { ok: true, commandId: dto.commandId, duplicate, data: challenge };
    } catch (error) {
      return this.errorAck(error);
    }
  }

  @SubscribeMessage('challenge:invite_create')
  async createInvite(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: InviteCreateDto): Promise<any> {
    try {
      const user = this.requireUser(socket);
      const { challenge, duplicate } = await this.challenge.createInvite(user.id, dto.gameModeId, dto.commandId);
      if (!duplicate) this.publisher.publishUser(user.id, 'challenge:created', challenge);
      return { ok: true, commandId: dto.commandId, duplicate, data: challenge };
    } catch (error) {
      return this.errorAck(error);
    }
  }

  @SubscribeMessage('challenge:invite_join')
  async joinInvite(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: InviteJoinDto): Promise<any> {
    try {
      const user = this.requireUser(socket);
      const result = await this.challenge.joinInvite(user.id, dto.code, dto.commandId);
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

  /** Recovery after reconnect: the caller's pending challenge (lobby, rematch or invite), if any. */
  @SubscribeMessage('challenge:active')
  async activeChallenge(@ConnectedSocket() socket: AuthenticatedSocket): Promise<any> {
    try {
      const user = this.requireUser(socket);
      return { ok: true, data: await this.challenge.activeForUser(user.id) };
    } catch (error) {
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

  @SubscribeMessage('admin:join_operations')
  async joinAdminOperations(@ConnectedSocket() socket: AuthenticatedSocket): Promise<any> {
    try {
      const user = this.requireUser(socket);
      if (user.role !== UserRole.ADMIN) throw new ForbiddenException({ code: 'ADMIN_ONLY', message: 'Admin access required.' });
      await socket.join(ADMIN_OPERATIONS_ROOM);
      return { ok: true };
    } catch (error) {
      return this.errorAck(error);
    }
  }

  /** Free practice against a bot (EASY | NORMAL | HARD). Resumes an unfinished one. */
  @SubscribeMessage('practice:start')
  async startPractice(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: PracticeStartDto): Promise<any> {
    try {
      const user = this.requireUser(socket);
      return { ok: true, commandId: dto.commandId, data: await this.practice.start(user.id, dto.level, dto.commandId) };
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
      const legalMoves = this.ludoRuntime.previewMoves(state);
      void this.botDriver.consider(state); // practice: a bot may need to roll first
      return { ok: true, state, timing, version: state.game.version, participants, recentMessages, legalMoves };
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

  /** Private message: delivered to both users' personal rooms (all their devices). */
  @SubscribeMessage('chat:direct:send')
  async sendDirectChat(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: DirectChatSendDto): Promise<any> {
    try {
      const user = this.requireUser(socket);
      const result = await this.directChat.send(user.id, dto.toUserId, dto.commandId, dto.text);
      if (!result.duplicate) {
        this.publisher.publishUser(dto.toUserId, 'chat:direct:message', result.message);
        this.publisher.publishUser(user.id, 'chat:direct:message', result.message);
      }
      return { ok: true, commandId: dto.commandId, duplicate: result.duplicate, data: result.message };
    } catch (error) {
      return this.errorAck(error);
    }
  }

  @SubscribeMessage('chat:direct:history')
  async directChatHistory(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: DirectChatPeerDto): Promise<any> {
    try {
      const user = this.requireUser(socket);
      return { ok: true, data: await this.directChat.history(user.id, dto.peerId, dto.before) };
    } catch (error) {
      return this.errorAck(error);
    }
  }

  @SubscribeMessage('chat:direct:read')
  async readDirectChat(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: DirectChatPeerDto): Promise<any> {
    try {
      const user = this.requireUser(socket);
      const changed = await this.directChat.markRead(user.id, dto.peerId);
      // Other devices of mine update their unread badge.
      if (changed > 0) this.publisher.publishUser(user.id, 'chat:direct:read', { peerId: dto.peerId });
      return { ok: true, data: { changed } };
    } catch (error) {
      return this.errorAck(error);
    }
  }

  @SubscribeMessage('chat:conversations')
  async conversations(@ConnectedSocket() socket: AuthenticatedSocket): Promise<any> {
    try {
      const user = this.requireUser(socket);
      return { ok: true, data: await this.directChat.conversations(user.id) };
    } catch (error) {
      return this.errorAck(error);
    }
  }

  @SubscribeMessage('match:reaction')
  async sendReaction(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: MatchReactionDto): Promise<any> {
    try {
      const user = this.requireUser(socket);
      const reaction = await this.chat.react(user.id, dto.matchId, dto.reactionId);
      this.publisher.publishRoom(this.publisher.matchRoom(dto.matchId), 'match:reaction', reaction, dto.matchId);
      return { ok: true };
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
      const legalMoves = this.ludoRuntime.previewMoves(state);
      return { ok: true, state, timing, version: state.game.version, participants, legalMoves };
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
