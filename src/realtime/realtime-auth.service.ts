import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { AuthenticatedSocket, RealtimeUser } from './realtime.types';

@Injectable()
export class RealtimeAuthService {
  constructor(private readonly authService: AuthService) {}

  async authenticate(socket: AuthenticatedSocket): Promise<RealtimeUser> {
    const authToken = typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : undefined;
    const header = socket.handshake.headers.authorization;
    const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined;
    const token = authToken ?? bearer;

    if (!token) {
      throw new UnauthorizedException({ code: 'SOCKET_AUTH_REQUIRED', message: 'Access token is required.' });
    }

    return this.authService.validateAccessToken(token);
  }
}
