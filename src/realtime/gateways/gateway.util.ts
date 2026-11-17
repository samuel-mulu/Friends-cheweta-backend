import { AuthenticatedSocket } from '../realtime.types';

/** What a socket handler returns to the client's acknowledgement callback. */
export type Ack = { ok: boolean } & Record<string, unknown>;

export function requireUser(socket: AuthenticatedSocket) {
  if (!socket.data.user) throw new Error('SOCKET_NOT_AUTHENTICATED');
  return socket.data.user;
}
