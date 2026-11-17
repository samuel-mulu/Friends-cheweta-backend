import { UseFilters, UsePipes, ValidationPipe } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { ChallengeService } from '../../challenge/challenge.service';
import { ChallengeAcceptFailedError } from '../../challenge/challenge.types';
import {
  ChallengeCommandDto,
  ChallengeCreateDto,
  ChallengeRematchDto,
  InviteCreateDto,
  InviteJoinDto,
} from '../../challenge/dto/challenge.dto';
import { ChatService } from '../../chat/chat.service';
import { LobbyCommandDto, LobbyJoinDto, LobbyJoinGameDto } from '../../lobby/dto/lobby.dto';
import { LobbyRooms } from '../../lobby/lobby-rooms';
import { LobbyService } from '../../lobby/lobby.service';
import { RealtimePublisherService } from '../realtime-publisher.service';
import { AuthenticatedSocket } from '../realtime.types';
import { WsAckExceptionFilter } from '../ws-ack-exception.filter';
import { toErrorAck } from '../ws-errors';
import { Ack, requireUser } from './gateway.util';

/** Lobby presence (join, ready, leave) and challenges, rematches and invites. */
@WebSocketGateway({ namespace: '/game' })
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
@UseFilters(new WsAckExceptionFilter())
export class LobbyGateway {
  constructor(
    private readonly lobby: LobbyService,
    private readonly challenge: ChallengeService,
    private readonly chat: ChatService,
    private readonly publisher: RealtimePublisherService,
    private readonly rooms: LobbyRooms,
  ) {}

  /**
   * A whole game's lobby: everyone at every stake, with the caller sitting at
   * one stake (chosen, kept, or the smallest). The socket follows the game's
   * room, so it sees changes at every stake.
   */
  @SubscribeMessage('lobby:join_game')
  async joinGame(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() dto: LobbyJoinGameDto,
  ): Promise<Ack> {
    try {
      const user = requireUser(socket);
      const activeChallenge = await this.challenge.activeForUser(user.id);
      const activeMatch = await this.lobby.activeMatchForUser(user.id);
      if (activeMatch) {
        await this.lobby.leave(user.id).catch(() => undefined);
        return { ok: true, commandId: dto.commandId, data: { activeMatch } };
      }
      const result = await this.lobby.joinGame(user.id, dto.gameCode, dto.gameModeId);
      if (result.changed) {
        if (result.previousGameModeId && result.previousGameModeId !== result.gameModeId) {
          await socket.leave(this.publisher.lobbyRoom(result.previousGameModeId));
          this.publisher.publishLobby(result.previousGameModeId, 'lobby:player_left', {
            player: result.player,
          });
        }
        this.publisher.publishLobby(result.gameModeId, 'lobby:player_joined', {
          player: result.player,
        });
      }
      const gameRoom = this.rooms.gameRoom(result.gameId);
      if (socket.data.lobbyGameRoom && socket.data.lobbyGameRoom !== gameRoom) {
        await socket.leave(socket.data.lobbyGameRoom);
      }
      await socket.join(gameRoom);
      socket.data.lobbyGameRoom = gameRoom;

      // One conversation per game: the chat of every stake, oldest first.
      const histories = await Promise.all(
        result.snapshot.stakes.map((stake) => this.chat.getLobbyHistory(stake.id).catch(() => [])),
      );
      const recentMessages = histories
        .flat()
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(-50);
      return {
        ok: true,
        commandId: dto.commandId,
        data: {
          ...result.snapshot,
          recentMessages,
          ...(activeChallenge ? { activeChallenge } : {}),
        },
      };
    } catch (error) {
      return toErrorAck(error);
    }
  }

  @SubscribeMessage('lobby:join')
  async joinLobby(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() dto: LobbyJoinDto,
  ): Promise<Ack> {
    try {
      const user = requireUser(socket);
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
        this.toLobby(result.previousGameModeId, 'lobby:player_left', { player: result.player });
      }
      await socket.join(this.publisher.lobbyRoom(dto.gameModeId));
      this.toLobby(dto.gameModeId, 'lobby:player_joined', { player: result.player });
      return {
        ok: true,
        commandId: dto.commandId,
        data: { ...result.snapshot, ...(activeChallenge ? { activeChallenge } : {}) },
      };
    } catch (error) {
      return toErrorAck(error);
    }
  }

  @SubscribeMessage('lobby:ready')
  async readyLobby(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() dto: LobbyCommandDto,
  ): Promise<Ack> {
    try {
      const result = await this.lobby.ready(requireUser(socket).id);
      this.toLobby(result.gameModeId, 'lobby:player_ready', { player: result.player });
      return { ok: true, commandId: dto.commandId };
    } catch (error) {
      return toErrorAck(error);
    }
  }

  @SubscribeMessage('lobby:unready')
  async unreadyLobby(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() dto: LobbyCommandDto,
  ): Promise<Ack> {
    try {
      const result = await this.lobby.unready(requireUser(socket).id);
      this.toLobby(result.gameModeId, 'lobby:player_unready', { player: result.player });
      return { ok: true, commandId: dto.commandId };
    } catch (error) {
      return toErrorAck(error);
    }
  }

  @SubscribeMessage('lobby:leave')
  async leaveLobby(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() dto: LobbyCommandDto,
  ): Promise<Ack> {
    try {
      const user = requireUser(socket);
      const cancelled = await this.challenge.cancelForUser(user.id);
      if (cancelled) this.publisher.publishChallengeTransition(cancelled);
      const result = await this.lobby.leave(user.id);
      if (result.gameModeId) {
        await socket.leave(this.publisher.lobbyRoom(result.gameModeId));
        this.toLobby(result.gameModeId, 'lobby:player_left', { player: result.player });
      }
      if (socket.data.lobbyGameRoom) {
        await socket.leave(socket.data.lobbyGameRoom);
        socket.data.lobbyGameRoom = undefined;
      }
      return { ok: true, commandId: dto.commandId };
    } catch (error) {
      return toErrorAck(error);
    }
  }

  @SubscribeMessage('challenge:create')
  async createChallenge(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() dto: ChallengeCreateDto,
  ): Promise<Ack> {
    try {
      const user = requireUser(socket);
      const result = await this.challenge.create(
        user.id,
        dto.opponentUserId,
        dto.commandId,
        dto.tokensToWin,
      );
      const challenge = result.challenge;
      for (const userId of [challenge.challengerId, challenge.opponentId]) {
        this.toLobby(challenge.gameModeId, 'lobby:player_busy', { userId });
      }
      this.publisher.publishUser(challenge.challengerId, 'challenge:created', challenge);
      this.publisher.publishUser(challenge.opponentId, 'challenge:received', challenge);
      return { ok: true, commandId: dto.commandId, duplicate: result.duplicate };
    } catch (error) {
      return toErrorAck(error);
    }
  }

  @SubscribeMessage('challenge:accept')
  async acceptChallenge(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() dto: ChallengeCommandDto,
  ): Promise<Ack> {
    try {
      const result = await this.challenge.accept(
        requireUser(socket).id,
        dto.challengeId,
        dto.commandId,
      );
      if (!result.duplicate) this.publisher.publishChallengeTransition(result);
      return {
        ok: true,
        commandId: dto.commandId,
        duplicate: result.duplicate,
        data: result.challenge,
      };
    } catch (error) {
      return this.acceptFailed(error);
    }
  }

  @SubscribeMessage('challenge:rematch')
  async requestRematch(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() dto: ChallengeRematchDto,
  ): Promise<Ack> {
    try {
      const { challenge, duplicate } = await this.challenge.createRematch(
        requireUser(socket).id,
        dto.matchId,
        dto.commandId,
      );
      if (!duplicate) {
        this.publisher.publishUser(challenge.challengerId, 'challenge:created', challenge);
        this.publisher.publishUser(challenge.opponentId, 'challenge:received', challenge);
      }
      return { ok: true, commandId: dto.commandId, duplicate, data: challenge };
    } catch (error) {
      return toErrorAck(error);
    }
  }

  @SubscribeMessage('challenge:invite_create')
  async createInvite(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() dto: InviteCreateDto,
  ): Promise<Ack> {
    try {
      const user = requireUser(socket);
      const { challenge, duplicate } = await this.challenge.createInvite(
        user.id,
        dto.gameModeId,
        dto.commandId,
        dto.tokensToWin,
      );
      if (!duplicate) this.publisher.publishUser(user.id, 'challenge:created', challenge);
      return { ok: true, commandId: dto.commandId, duplicate, data: challenge };
    } catch (error) {
      return toErrorAck(error);
    }
  }

  @SubscribeMessage('challenge:invite_join')
  async joinInvite(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() dto: InviteJoinDto,
  ): Promise<Ack> {
    try {
      const result = await this.challenge.joinInvite(
        requireUser(socket).id,
        dto.code,
        dto.commandId,
      );
      if (!result.duplicate) this.publisher.publishChallengeTransition(result);
      return {
        ok: true,
        commandId: dto.commandId,
        duplicate: result.duplicate,
        data: result.challenge,
      };
    } catch (error) {
      return this.acceptFailed(error);
    }
  }

  /** Recovery after reconnect: the caller's pending challenge (lobby, rematch or invite), if any. */
  @SubscribeMessage('challenge:active')
  async activeChallenge(@ConnectedSocket() socket: AuthenticatedSocket): Promise<Ack> {
    try {
      return { ok: true, data: await this.challenge.activeForUser(requireUser(socket).id) };
    } catch (error) {
      return toErrorAck(error);
    }
  }

  @SubscribeMessage('challenge:reject')
  async rejectChallenge(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() dto: ChallengeCommandDto,
  ): Promise<Ack> {
    try {
      const result = await this.challenge.reject(
        requireUser(socket).id,
        dto.challengeId,
        dto.commandId,
      );
      if (!result.duplicate) this.publisher.publishChallengeTransition(result);
      return { ok: true, commandId: dto.commandId, duplicate: result.duplicate };
    } catch (error) {
      return toErrorAck(error);
    }
  }

  @SubscribeMessage('challenge:cancel')
  async cancelChallenge(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() dto: ChallengeCommandDto,
  ): Promise<Ack> {
    try {
      const result = await this.challenge.cancel(
        requireUser(socket).id,
        dto.challengeId,
        dto.commandId,
      );
      if (!result.duplicate) this.publisher.publishChallengeTransition(result);
      return { ok: true, commandId: dto.commandId, duplicate: result.duplicate };
    } catch (error) {
      return toErrorAck(error);
    }
  }

  private toLobby(gameModeId: string, event: string, data: Record<string, unknown>): void {
    this.publisher.publishLobby(gameModeId, event, data);
  }

  /** A failed accept still changes the challenge: tell both players, then report the reason. */
  private acceptFailed(error: unknown): Ack {
    if (error instanceof ChallengeAcceptFailedError) {
      this.publisher.publishChallengeTransition(error.transition);
      return toErrorAck(error.reason);
    }
    return toErrorAck(error);
  }
}
