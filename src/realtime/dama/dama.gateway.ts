import { UseFilters, UsePipes, ValidationPipe } from '@nestjs/common';
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { ChatService } from '../../chat/chat.service';
import { DamaMatchRuntimeState, DamaRuntimeCommand } from '../../games/dama/runtime';
import { DamaBotDriverService } from '../../practice/dama-bot-driver.service';
import { MatchJoinDto } from '../dto/ludo-command.dto';
import { RealtimePublisherService } from '../realtime-publisher.service';
import { AuthenticatedSocket } from '../realtime.types';
import { WsAckExceptionFilter } from '../ws-ack-exception.filter';
import { toErrorAck } from '../ws-errors';
import { DamaCommandDto, DamaMoveDto } from './dama-command.dto';
import { DamaRuntimeService } from './dama-runtime.service';
import { DamaTurnTimerService } from './dama-turn-timer.service';

/**
 * Dama commands on the shared `/game` namespace (connection, auth, chat and
 * reactions are handled by RealtimeGateway; the match room is the same).
 */
@WebSocketGateway({ namespace: '/game' })
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
@UseFilters(new WsAckExceptionFilter())
export class DamaGateway {
  constructor(
    private readonly runtime: DamaRuntimeService,
    private readonly timer: DamaTurnTimerService,
    private readonly publisher: RealtimePublisherService,
    private readonly chat: ChatService,
    private readonly bots: DamaBotDriverService,
  ) {}

  @SubscribeMessage('dama:join')
  async join(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: MatchJoinDto): Promise<any> {
    try {
      const user = this.requireUser(socket);
      const state = await this.runtime.getSnapshot(dto.matchId, user.id);
      await socket.join(this.publisher.matchRoom(dto.matchId));
      const timing = await this.timer.onMatchJoined(dto.matchId, user.id, state);
      const recentMessages = await this.chat.getMatchHistory(dto.matchId).catch(() => []);
      void this.bots.consider(state); // practice: the bot may have the first move
      return { ...(await this.snapshot(dto.matchId, state)), timing, recentMessages };
    } catch (error) {
      return toErrorAck(error);
    }
  }

  @SubscribeMessage('dama:sync')
  async sync(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: MatchJoinDto): Promise<any> {
    try {
      const user = this.requireUser(socket);
      const state = await this.runtime.getSnapshot(dto.matchId, user.id);
      return { ...(await this.snapshot(dto.matchId, state)), timing: await this.timer.getTiming(state) };
    } catch (error) {
      return toErrorAck(error);
    }
  }

  @SubscribeMessage('dama:move')
  move(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: DamaMoveDto): Promise<any> {
    return this.execute(socket, dto, { type: 'MOVE', path: dto.path });
  }

  @SubscribeMessage('dama:resign')
  resign(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: DamaCommandDto): Promise<any> {
    return this.execute(socket, dto, { type: 'RESIGN' });
  }

  private async execute(
    socket: AuthenticatedSocket,
    dto: DamaCommandDto,
    command: { type: 'MOVE'; path: number[] } | { type: 'RESIGN' },
  ): Promise<any> {
    try {
      const user = this.requireUser(socket);
      if (!socket.rooms.has(this.publisher.matchRoom(dto.matchId))) throw new Error('MATCH_ROOM_NOT_JOINED');
      const result = await this.runtime.execute({
        ...command,
        matchId: dto.matchId,
        commandId: dto.commandId,
        playerId: user.id,
        expectedVersion: dto.expectedVersion,
      } as DamaRuntimeCommand & { matchId: string });
      this.publisher.publishDamaExecution(result);
      if (!result.duplicate) await this.timer.afterMove(result.state, user.id);
      return { ok: true, commandId: dto.commandId, version: result.state.game.version, duplicate: result.duplicate };
    } catch (error) {
      return toErrorAck(error);
    }
  }

  private async snapshot(matchId: string, state: DamaMatchRuntimeState) {
    return {
      ok: true as const,
      state,
      version: state.game.version,
      participants: await this.runtime.getParticipantViews(matchId, state),
      legalMoves: this.runtime.legalMoves(state),
    };
  }

  private requireUser(socket: AuthenticatedSocket) {
    if (!socket.data.user) throw new Error('SOCKET_NOT_AUTHENTICATED');
    return socket.data.user;
  }
}
