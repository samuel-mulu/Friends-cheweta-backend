import { ChatService } from '../../chat/chat.service';
import { LudoCommandDto, MatchJoinDto } from '../dto/ludo-command.dto';
import { RealtimePublisherService } from '../realtime-publisher.service';
import { AuthenticatedSocket } from '../realtime.types';
import { toErrorAck } from '../ws-errors';
import { CommandBody, TurnGameCommand, TurnGameEvent, TurnGameState } from './turn-game.definition';
import { TurnGameRuntime } from './turn-game-runtime';
import { TurnGameTimer } from './turn-game-timer';

/**
 * Shared socket handling for a turn game (join, sync, commands). A concrete
 * gateway declares its `@SubscribeMessage` handlers and calls these.
 * Connection, auth, chat and reactions live in RealtimeGateway; the match
 * room is shared.
 */
export abstract class TurnGameGateway<S extends TurnGameState, C extends TurnGameCommand, E extends TurnGameEvent> {
  protected constructor(
    protected readonly runtime: TurnGameRuntime<S, C, E>,
    protected readonly timer: TurnGameTimer<S, C, E>,
    protected readonly publisher: RealtimePublisherService,
    protected readonly chat: ChatService,
  ) {}

  /** Extra fields for join/sync acks (e.g. Dama's legal moves). */
  protected snapshotExtras(_state: S): Record<string, unknown> {
    return {};
  }

  /** Called after a player joins (e.g. a practice bot may act first). */
  protected onJoined(_state: S): void {}

  protected async joinMatch(socket: AuthenticatedSocket, dto: MatchJoinDto): Promise<any> {
    try {
      const user = this.requireUser(socket);
      const state = await this.runtime.getSnapshot(dto.matchId, user.id);
      await socket.join(this.publisher.matchRoom(dto.matchId));
      const timing = await this.timer.onMatchJoined(dto.matchId, user.id, state);
      const recentMessages = await this.chat.getMatchHistory(dto.matchId).catch(() => []);
      this.onJoined(state);
      return { ...(await this.snapshot(dto.matchId, state)), timing, recentMessages };
    } catch (error) {
      return toErrorAck(error);
    }
  }

  protected async syncMatch(socket: AuthenticatedSocket, dto: MatchJoinDto): Promise<any> {
    try {
      const user = this.requireUser(socket);
      const state = await this.runtime.getSnapshot(dto.matchId, user.id);
      return { ...(await this.snapshot(dto.matchId, state)), timing: await this.timer.getTiming(state) };
    } catch (error) {
      return toErrorAck(error);
    }
  }

  protected async command(socket: AuthenticatedSocket, dto: LudoCommandDto, body: CommandBody<C>): Promise<any> {
    try {
      const user = this.requireUser(socket);
      if (!socket.rooms.has(this.publisher.matchRoom(dto.matchId))) throw new Error('MATCH_ROOM_NOT_JOINED');
      const result = await this.runtime.execute({
        ...body,
        matchId: dto.matchId,
        commandId: dto.commandId,
        playerId: user.id,
        expectedVersion: dto.expectedVersion,
      } as unknown as C & { matchId: string });
      this.publisher.publishTurnGame(result, this.runtime.definition);
      if (!result.duplicate) await this.timer.afterCommand(result.state, user.id);
      return { ok: true, commandId: dto.commandId, version: result.state.game.version, duplicate: result.duplicate };
    } catch (error) {
      return toErrorAck(error);
    }
  }

  private async snapshot(matchId: string, state: S) {
    return {
      ok: true as const,
      state: this.runtime.definition.publicState(state),
      version: state.game.version,
      participants: await this.runtime.getParticipantViews(matchId, state),
      ...this.snapshotExtras(state),
    };
  }

  private requireUser(socket: AuthenticatedSocket) {
    if (!socket.data.user) throw new Error('SOCKET_NOT_AUTHENTICATED');
    return socket.data.user;
  }
}
