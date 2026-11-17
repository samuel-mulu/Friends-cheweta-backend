import { UseFilters, UsePipes, ValidationPipe } from '@nestjs/common';
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { PracticeStartDto } from '../../practice/dto/practice.dto';
import { PracticeService } from '../../practice/practice.service';
import { AuthenticatedSocket } from '../realtime.types';
import { WsAckExceptionFilter } from '../ws-ack-exception.filter';
import { toErrorAck } from '../ws-errors';
import { Ack, requireUser } from './gateway.util';

@WebSocketGateway({ namespace: '/game' })
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
@UseFilters(new WsAckExceptionFilter())
export class PracticeGateway {
  constructor(private readonly practice: PracticeService) {}

  /** Free practice against a bot (EASY | NORMAL | HARD). Resumes an unfinished one. */
  @SubscribeMessage('practice:start')
  async startPractice(@ConnectedSocket() socket: AuthenticatedSocket, @MessageBody() dto: PracticeStartDto): Promise<Ack> {
    try {
      const user = requireUser(socket);
      const data = await this.practice.start(user.id, dto.level, dto.commandId, dto.tokensToWin, dto.game);
      return { ok: true, commandId: dto.commandId, data };
    } catch (error) {
      return toErrorAck(error);
    }
  }
}
