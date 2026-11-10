import { UseFilters, UsePipes, ValidationPipe } from '@nestjs/common';
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { ChatService } from '../../chat/chat.service';
import { DamaMatchRuntimeState, DamaRuntimeCommand, DamaRuntimeEvent } from '../../games/dama/runtime';
import { DamaBotDriverService } from '../../practice/dama-bot-driver.service';
import { MatchJoinDto } from '../dto/ludo-command.dto';
import { RealtimePublisherService } from '../realtime-publisher.service';
import { AuthenticatedSocket } from '../realtime.types';
import { TurnGameGateway } from '../turn-game/turn-game-gateway';
import { WsAckExceptionFilter } from '../ws-ack-exception.filter';
import { DamaCommandDto, DamaMoveDto } from './dama-command.dto';
import { DamaRuntimeService } from './dama-runtime.service';
import { DamaTurnTimerService } from './dama-turn-timer.service';

/** Dama commands on the shared `/game` namespace. */
@WebSocketGateway({ namespace: '/game' })
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
@UseFilters(new WsAckExceptionFilter())
export class DamaGateway extends TurnGameGateway<DamaMatchRuntimeState, DamaRuntimeCommand, DamaRuntimeEvent> {
  constructor(
    private readonly dama: DamaRuntimeService,
    timer: DamaTurnTimerService,
    publisher: RealtimePublisherService,
    chat: ChatService,
    private readonly bots: DamaBotDriverService,
  ) {
    super(dama, timer, publisher, chat);
  }

  protected override snapshotExtras(state: DamaMatchRuntimeState) {
    return { legalMoves: this.dama.legalMoves(state) };
  }

  protected override onJoined(state: DamaMatchRuntimeState): void {
    void this.bots.consider(state); // practice: the bot may have the first move
  }

  @SubscribeMessage('dama:join')
  join(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: MatchJoinDto) {
    return this.joinMatch(socket, dto);
  }

  @SubscribeMessage('dama:sync')
  sync(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: MatchJoinDto) {
    return this.syncMatch(socket, dto);
  }

  @SubscribeMessage('dama:move')
  move(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: DamaMoveDto) {
    return this.command(socket, dto, { type: 'MOVE', path: dto.path });
  }

  @SubscribeMessage('dama:resign')
  resign(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: DamaCommandDto) {
    return this.command(socket, dto, { type: 'RESIGN' });
  }
}
