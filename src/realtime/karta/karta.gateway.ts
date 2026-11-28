import { UseFilters, UsePipes, ValidationPipe } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { IsBoolean, IsIn, IsInt, IsString, Max, Min, MinLength } from 'class-validator';
import { ChatService } from '../../chat/chat.service';
import {
  KARTA_RANKS,
  KartaMatchRuntimeState,
  KartaRank,
  KartaRuntimeCommand,
  KartaRuntimeEvent,
} from '../../games/karta';
import { LudoCommandDto, MatchJoinDto } from '../dto/ludo-command.dto';
import { Ack, requireUser } from '../gateways/gateway.util';
import { RealtimePublisherService } from '../realtime-publisher.service';
import { AuthenticatedSocket } from '../realtime.types';
import { TurnGameGateway } from '../turn-game/turn-game-gateway';
import { WsAckExceptionFilter } from '../ws-ack-exception.filter';
import { toErrorAck } from '../ws-errors';
import { KartaRuntimeService, KartaTurnTimerService } from './karta.game';
import { KartaTableService } from './karta-table.service';

export class KartaCallDto extends LudoCommandDto {
  @IsIn(KARTA_RANKS)
  rank!: KartaRank;
}

export class KartaTableJoinDto {
  @IsString()
  @MinLength(1)
  tableId!: string;
}

export class KartaTableRaiseDto {
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  amountMinor!: number;
}

export class KartaTableAnswerDto {
  @IsBoolean()
  accept!: boolean;
}

/** Karta Lat Lat commands on the shared `/game` namespace. */
@WebSocketGateway({ namespace: '/game' })
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
@UseFilters(new WsAckExceptionFilter())
export class KartaGateway extends TurnGameGateway<
  KartaMatchRuntimeState,
  KartaRuntimeCommand,
  KartaRuntimeEvent
> {
  constructor(
    runtime: KartaRuntimeService,
    timer: KartaTurnTimerService,
    publisher: RealtimePublisherService,
    chat: ChatService,
    private readonly tables: KartaTableService,
  ) {
    super(runtime, timer, publisher, chat);
  }

  /** Players join their match; others seated at its table watch it (read-only). */
  @SubscribeMessage('karta:join')
  async join(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: MatchJoinDto) {
    return (await this.watching(socket, dto.matchId))
      ? this.watch(socket, dto, true)
      : this.joinMatch(socket, dto);
  }

  @SubscribeMessage('karta:sync')
  async sync(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: MatchJoinDto) {
    return (await this.watching(socket, dto.matchId))
      ? this.watch(socket, dto, false)
      : this.syncMatch(socket, dto);
  }

  /** The table I sit at (null when none). */
  @SubscribeMessage('karta:table:mine')
  async tableMine(@ConnectedSocket() socket: AuthenticatedSocket): Promise<Ack> {
    try {
      return { ok: true, data: await this.tables.mine(requireUser(socket).id) };
    } catch (error) {
      return toErrorAck(error);
    }
  }

  /** Join the back of a table's queue while a seat is free. */
  @SubscribeMessage('karta:table:join')
  async tableJoin(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() dto: KartaTableJoinDto,
  ): Promise<Ack> {
    try {
      return { ok: true, data: await this.tables.join(requireUser(socket).id, dto.tableId) };
    } catch (error) {
      return toErrorAck(error);
    }
  }

  @SubscribeMessage('karta:table:leave')
  async tableLeave(@ConnectedSocket() socket: AuthenticatedSocket): Promise<Ack> {
    try {
      await this.tables.leave(requireUser(socket).id);
      return { ok: true };
    } catch (error) {
      return toErrorAck(error);
    }
  }

  @SubscribeMessage('karta:table:raise')
  async tableRaise(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() dto: KartaTableRaiseDto,
  ): Promise<Ack> {
    try {
      return {
        ok: true,
        data: await this.tables.proposeRaise(requireUser(socket).id, dto.amountMinor),
      };
    } catch (error) {
      return toErrorAck(error);
    }
  }

  @SubscribeMessage('karta:table:raise_answer')
  async tableRaiseAnswer(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() dto: KartaTableAnswerDto,
  ): Promise<Ack> {
    try {
      return { ok: true, data: await this.tables.answerRaise(requireUser(socket).id, dto.accept) };
    } catch (error) {
      return toErrorAck(error);
    }
  }

  /** Seated at this match's table but not one of its two players. */
  private async watching(socket: AuthenticatedSocket, matchId: string): Promise<boolean> {
    const state = await this.runtime.getStoredSnapshot(matchId).catch(() => null);
    const userId = socket.data.user?.id;
    if (!userId || !state || state.game.players.some((p) => p.userId === userId)) return false;
    return this.tables.canWatch(matchId, userId);
  }

  /** A watcher gets the live round (no turn clock, no commands). */
  private async watch(
    socket: AuthenticatedSocket,
    dto: MatchJoinDto,
    joinRoom: boolean,
  ): Promise<Ack> {
    try {
      const state = await this.runtime.getStoredSnapshot(dto.matchId);
      if (!state) throw new Error('MATCH_NOT_FOUND');
      if (joinRoom) await socket.join(this.publisher.matchRoom(dto.matchId));
      return {
        ...(await this.snapshot(dto.matchId, state)),
        timing: await this.timer.getTiming(state),
        watching: true,
      };
    } catch (error) {
      return toErrorAck(error);
    }
  }

  @SubscribeMessage('karta:call')
  call(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: KartaCallDto) {
    return this.command(socket, dto, { type: 'CALL', rank: dto.rank });
  }

  @SubscribeMessage('karta:flip')
  flip(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: LudoCommandDto) {
    return this.command(socket, dto, { type: 'FLIP' });
  }

  @SubscribeMessage('karta:resign')
  resign(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: LudoCommandDto) {
    return this.command(socket, dto, { type: 'RESIGN' });
  }
}
