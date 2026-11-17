import { UseFilters, UsePipes, ValidationPipe } from '@nestjs/common';
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { ChatService } from '../../chat/chat.service';
import { DirectChatService } from '../../chat/direct-chat.service';
import {
  DirectChatPeerDto,
  DirectChatSendDto,
  LobbyChatSendDto,
  MatchChatHistoryDto,
  MatchChatSendDto,
  MatchReactionDto,
} from '../../chat/dto/chat.dto';
import { RealtimePublisherService } from '../realtime-publisher.service';
import { AuthenticatedSocket } from '../realtime.types';
import { WsAckExceptionFilter } from '../ws-ack-exception.filter';
import { toErrorAck } from '../ws-errors';
import { Ack, requireUser } from './gateway.util';

/** Lobby chat, match chat and reactions, and private messages. */
@WebSocketGateway({ namespace: '/game' })
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
@UseFilters(new WsAckExceptionFilter())
export class ChatGateway {
  constructor(
    private readonly chat: ChatService,
    private readonly directChat: DirectChatService,
    private readonly publisher: RealtimePublisherService,
  ) {}

  @SubscribeMessage('lobby:chat:send')
  async sendLobbyChat(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: LobbyChatSendDto): Promise<Ack> {
    try {
      const result = await this.chat.sendLobbyMessage(requireUser(socket).id, dto.commandId, dto.text);
      if (!result.duplicate) {
        this.publisher.publishRoom(this.publisher.lobbyRoom(result.message.scopeId), 'lobby:chat:message', result.message);
      }
      return { ok: true, commandId: dto.commandId, duplicate: result.duplicate, data: result.message };
    } catch (error) {
      return toErrorAck(error);
    }
  }

  @SubscribeMessage('match:chat:send')
  async sendMatchChat(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: MatchChatSendDto): Promise<Ack> {
    try {
      const result = await this.chat.sendMatchMessage(requireUser(socket).id, dto.matchId, dto.commandId, dto.text);
      if (!result.duplicate) {
        this.publisher.publishRoom(this.publisher.matchRoom(dto.matchId), 'match:chat:message', result.message, dto.matchId);
      }
      return { ok: true, commandId: dto.commandId, duplicate: result.duplicate, data: result.message };
    } catch (error) {
      return toErrorAck(error);
    }
  }

  @SubscribeMessage('match:chat:history')
  async matchChatHistory(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: MatchChatHistoryDto): Promise<Ack> {
    try {
      const messages = await this.chat.getMatchHistoryForUser(requireUser(socket).id, dto.matchId);
      return { ok: true, messages };
    } catch (error) {
      return toErrorAck(error);
    }
  }

  @SubscribeMessage('match:reaction')
  async sendReaction(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: MatchReactionDto): Promise<Ack> {
    try {
      const reaction = await this.chat.react(requireUser(socket).id, dto.matchId, dto.reactionId);
      this.publisher.publishRoom(this.publisher.matchRoom(dto.matchId), 'match:reaction', reaction, dto.matchId);
      return { ok: true };
    } catch (error) {
      return toErrorAck(error);
    }
  }

  /** Private message: delivered to both users' personal rooms (all their devices). */
  @SubscribeMessage('chat:direct:send')
  async sendDirectChat(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: DirectChatSendDto): Promise<Ack> {
    try {
      const user = requireUser(socket);
      const result = await this.directChat.send(user.id, dto.toUserId, dto.commandId, dto.text);
      if (!result.duplicate) {
        this.publisher.publishUser(dto.toUserId, 'chat:direct:message', result.message);
        this.publisher.publishUser(user.id, 'chat:direct:message', result.message);
      }
      return { ok: true, commandId: dto.commandId, duplicate: result.duplicate, data: result.message };
    } catch (error) {
      return toErrorAck(error);
    }
  }

  @SubscribeMessage('chat:direct:history')
  async directChatHistory(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: DirectChatPeerDto): Promise<Ack> {
    try {
      return { ok: true, data: await this.directChat.history(requireUser(socket).id, dto.peerId, dto.before) };
    } catch (error) {
      return toErrorAck(error);
    }
  }

  @SubscribeMessage('chat:direct:read')
  async readDirectChat(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: DirectChatPeerDto): Promise<Ack> {
    try {
      const user = requireUser(socket);
      const changed = await this.directChat.markRead(user.id, dto.peerId);
      // Other devices of mine update their unread badge.
      if (changed > 0) this.publisher.publishUser(user.id, 'chat:direct:read', { peerId: dto.peerId });
      return { ok: true, data: { changed } };
    } catch (error) {
      return toErrorAck(error);
    }
  }

  @SubscribeMessage('chat:conversations')
  async conversations(@ConnectedSocket() socket: AuthenticatedSocket): Promise<Ack> {
    try {
      return { ok: true, data: await this.directChat.conversations(requireUser(socket).id) };
    } catch (error) {
      return toErrorAck(error);
    }
  }
}
