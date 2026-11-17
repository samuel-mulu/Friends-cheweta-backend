import { ForbiddenException, UseFilters } from '@nestjs/common';
import { ConnectedSocket, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { UserRole } from '../../generated/prisma/enums';
import { ADMIN_OPERATIONS_ROOM } from '../realtime-publisher.service';
import { AuthenticatedSocket } from '../realtime.types';
import { WsAckExceptionFilter } from '../ws-ack-exception.filter';
import { toErrorAck } from '../ws-errors';
import { Ack, requireUser } from './gateway.util';

@WebSocketGateway({ namespace: '/game' })
@UseFilters(new WsAckExceptionFilter())
export class AdminGateway {
  /** Admin dashboards receive a read-only copy of every match event. */
  @SubscribeMessage('admin:join_operations')
  async joinAdminOperations(@ConnectedSocket() socket: AuthenticatedSocket): Promise<Ack> {
    try {
      if (requireUser(socket).role !== UserRole.ADMIN) {
        throw new ForbiddenException({ code: 'ADMIN_ONLY', message: 'Admin access required.' });
      }
      await socket.join(ADMIN_OPERATIONS_ROOM);
      return { ok: true };
    } catch (error) {
      return toErrorAck(error);
    }
  }
}
