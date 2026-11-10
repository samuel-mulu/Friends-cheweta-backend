import { UseFilters, UsePipes, ValidationPipe } from '@nestjs/common';
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { IsIn } from 'class-validator';
import { ChatService } from '../../chat/chat.service';
import { KARTA_RANKS, KartaMatchRuntimeState, KartaRank, KartaRuntimeCommand, KartaRuntimeEvent } from '../../games/karta';
import { LudoCommandDto, MatchJoinDto } from '../dto/ludo-command.dto';
import { RealtimePublisherService } from '../realtime-publisher.service';
import { AuthenticatedSocket } from '../realtime.types';
import { TurnGameGateway } from '../turn-game/turn-game-gateway';
import { WsAckExceptionFilter } from '../ws-ack-exception.filter';
import { KartaRuntimeService, KartaTurnTimerService } from './karta.game';

export class KartaCallDto extends LudoCommandDto {
  @IsIn(KARTA_RANKS)
  rank!: KartaRank;
}

/** Karta Lat Lat commands on the shared `/game` namespace. */
@WebSocketGateway({ namespace: '/game' })
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
@UseFilters(new WsAckExceptionFilter())
export class KartaGateway extends TurnGameGateway<KartaMatchRuntimeState, KartaRuntimeCommand, KartaRuntimeEvent> {
  constructor(runtime: KartaRuntimeService, timer: KartaTurnTimerService, publisher: RealtimePublisherService, chat: ChatService) {
    super(runtime, timer, publisher, chat);
  }

  @SubscribeMessage('karta:join')
  join(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: MatchJoinDto) {
    return this.joinMatch(socket, dto);
  }

  @SubscribeMessage('karta:sync')
  sync(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: MatchJoinDto) {
    return this.syncMatch(socket, dto);
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
