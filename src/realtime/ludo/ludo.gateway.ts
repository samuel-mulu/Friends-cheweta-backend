import { UseFilters, UsePipes, ValidationPipe } from '@nestjs/common';
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { ChatService } from '../../chat/chat.service';
import { LudoMatchRuntimeState, LudoRuntimeCommand, LudoRuntimeEvent } from '../../games/ludo/runtime';
import { BotDriverService } from '../../practice/bot-driver.service';
import { LudoCommandDto, LudoMoveCommandDto, MatchJoinDto } from '../dto/ludo-command.dto';
import { RealtimePublisherService } from '../realtime-publisher.service';
import { AuthenticatedSocket } from '../realtime.types';
import { TurnGameGateway } from '../turn-game/turn-game-gateway';
import { WsAckExceptionFilter } from '../ws-ack-exception.filter';
import { LudoRuntimeService, LudoTurnTimerService } from './ludo-runtime.service';

/**
 * Ludo commands on the shared `/game` namespace. `match:join` is Ludo's join
 * (historic name; Dama and Karta use `<game>:join`).
 */
@WebSocketGateway({ namespace: '/game' })
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
@UseFilters(new WsAckExceptionFilter())
export class LudoGateway extends TurnGameGateway<LudoMatchRuntimeState, LudoRuntimeCommand, LudoRuntimeEvent> {
  constructor(
    runtime: LudoRuntimeService,
    timer: LudoTurnTimerService,
    publisher: RealtimePublisherService,
    chat: ChatService,
    private readonly bots: BotDriverService,
  ) {
    super(runtime, timer, publisher, chat);
  }

  protected override onJoined(state: LudoMatchRuntimeState): void {
    void this.bots.consider(state); // practice: a bot may need to roll first
  }

  @SubscribeMessage('match:join')
  join(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: MatchJoinDto) {
    return this.joinMatch(socket, dto);
  }

  @SubscribeMessage('ludo:sync')
  sync(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: MatchJoinDto) {
    return this.syncMatch(socket, dto);
  }

  @SubscribeMessage('ludo:roll_for_start')
  rollForStart(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: LudoCommandDto) {
    return this.command(socket, dto, { type: 'ROLL_FOR_START' });
  }

  @SubscribeMessage('ludo:roll')
  roll(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: LudoCommandDto) {
    return this.command(socket, dto, { type: 'ROLL_DICE' });
  }

  @SubscribeMessage('ludo:move')
  move(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: LudoMoveCommandDto) {
    return this.command(socket, dto, { type: 'MOVE_TOKEN', tokenId: dto.tokenId });
  }

  @SubscribeMessage('ludo:resign')
  resign(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: LudoCommandDto) {
    return this.command(socket, dto, { type: 'RESIGN' });
  }
}
