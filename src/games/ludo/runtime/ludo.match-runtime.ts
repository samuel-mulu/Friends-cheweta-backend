import { DiceProvider } from '../dice';
import {
  LUDO_CLASSIC_V1,
  LudoGameState,
  LudoRulesVersion,
  rulesFor,
  LudoMatchPhase,
  LudoTokenState,
  LudoTurnPhase,
  assertValidLudoState,
  createInitialLudoState,
} from '../domain';
import { LudoEngine } from '../engine';
import {
  LudoMatchRuntimeState,
  LudoRuntimeCommand,
  LudoRuntimeEvent,
  LudoRuntimeEventType,
  LudoRuntimeResult,
  MoveTokenCommand,
  ResignCommand,
  RollDiceCommand,
  RollForStartCommand,
} from './ludo.runtime.types';

function cloneGameState(state: LudoGameState): LudoGameState {
  return {
    ...state,
    players: state.players.map((player) => ({
      ...player,
      tokens: player.tokens.map((token) => ({ ...token })),
    })),
    legalTokenIds: [...state.legalTokenIds],
    winnerOrder: [...state.winnerOrder],
  };
}

function cloneRuntimeState(state: LudoMatchRuntimeState): LudoMatchRuntimeState {
  return {
    game: cloneGameState(state.game),
    startingRoll: {
      round: state.startingRoll.round,
      candidatePlayerIds: [...state.startingRoll.candidatePlayerIds],
      rolls: { ...state.startingRoll.rolls },
    },
    resignedPlayerIds: [...state.resignedPlayerIds],
  };
}

function cloneResult(result: LudoRuntimeResult): LudoRuntimeResult {
  return {
    commandId: result.commandId,
    state: cloneRuntimeState(result.state),
    events: result.events.map((event) => ({
      ...event,
      tokenIds: event.tokenIds ? [...event.tokenIds] : undefined,
      winnerOrder: event.winnerOrder ? [...event.winnerOrder] : undefined,
      candidatePlayerIds: event.candidatePlayerIds ? [...event.candidatePlayerIds] : undefined,
      move: event.move
        ? {
            ...event.move,
            move: { ...event.move.move, capturedTokenIds: [...event.move.move.capturedTokenIds] },
            tokenBefore: { ...event.move.tokenBefore },
            tokenAfter: { ...event.move.tokenAfter },
            capturedTokenIds: [...event.move.capturedTokenIds],
          }
        : undefined,
    })),
  };
}

function ensureCommandId(commandId: string): void {
  if (!commandId.trim()) throw new Error('COMMAND_ID_REQUIRED');
}

/**
 * B9 authoritative in-process match runtime.
 *
 * This object deliberately owns all turn/lifecycle transitions for one match.
 * It has no Socket.IO, Redis, Prisma, or wall-clock dependency. B12/B14 can
 * wrap this runtime with distributed persistence, locks, timers, and recovery.
 */
export class LudoMatchRuntime {
  private state: LudoMatchRuntimeState;

  constructor(
    matchId: string,
    playerIds: string[],
    private readonly dice: DiceProvider,
    private readonly engine = new LudoEngine(),
    rulesVersion: LudoRulesVersion = LUDO_CLASSIC_V1.version,
  ) {
    const game = createInitialLudoState(matchId, playerIds, rulesVersion);
    this.state = {
      game,
      startingRoll: {
        round: 1,
        candidatePlayerIds: [...playerIds],
        rolls: {},
      },
      resignedPlayerIds: [],
    };
  }

  static restore(
    state: LudoMatchRuntimeState,
    dice: DiceProvider,
    engine = new LudoEngine(),
  ): LudoMatchRuntime {
    const runtime = new LudoMatchRuntime(
      state.game.matchId,
      state.game.players.map((player) => player.userId),
      dice,
      engine,
    );
    runtime.state = cloneRuntimeState(state);
    runtime.assertRuntimeState();
    return runtime;
  }

  /** Rules this match was created with (stored in its state). */
  private get rules() {
    return rulesFor(this.state.game.rulesVersion);
  }

  getState(): LudoMatchRuntimeState {
    return cloneRuntimeState(this.state);
  }

  execute(command: LudoRuntimeCommand): LudoRuntimeResult {
    // Command idempotency is enforced by the persistence layer (LudoRuntimeService).
    ensureCommandId(command.commandId);
    if (command.expectedVersion !== this.state.game.version) {
      throw new Error('MATCH_VERSION_CONFLICT');
    }

    let events: LudoRuntimeEvent[];
    switch (command.type) {
      case 'ROLL_FOR_START':
        events = this.rollForStart(command);
        break;
      case 'ROLL_DICE':
        events = this.rollDice(command);
        break;
      case 'MOVE_TOKEN':
        events = this.moveToken(command);
        break;
      case 'RESIGN':
        events = this.resign(command);
        break;
      default: {
        const exhaustive: never = command;
        throw new Error(`Unsupported command: ${String(exhaustive)}`);
      }
    }

    this.assertRuntimeState();
    return {
      commandId: command.commandId,
      state: this.getState(),
      events: cloneResult({ commandId: command.commandId, state: this.state, events }).events,
    };
  }

  private rollForStart(command: RollForStartCommand): LudoRuntimeEvent[] {
    const game = this.state.game;
    if (game.phase !== LudoMatchPhase.PRE_GAME || game.turnPhase !== LudoTurnPhase.START_ROLL) {
      throw new Error('STARTING_ROLL_CLOSED');
    }
    if (!this.state.startingRoll.candidatePlayerIds.includes(command.playerId)) {
      throw new Error('PLAYER_NOT_ELIGIBLE_FOR_STARTING_ROLL');
    }
    if (this.state.startingRoll.rolls[command.playerId] !== undefined) {
      throw new Error('STARTING_ROLL_ALREADY_TAKEN');
    }

    const value = this.dice.roll();
    this.state.startingRoll.rolls[command.playerId] = value;
    game.version += 1;

    const events: LudoRuntimeEvent[] = [
      this.event(LudoRuntimeEventType.STARTING_ROLL, {
        playerId: command.playerId,
        diceValue: value,
        round: this.state.startingRoll.round,
      }),
    ];

    const candidates = this.state.startingRoll.candidatePlayerIds;
    if (Object.keys(this.state.startingRoll.rolls).length !== candidates.length) return events;

    const highest = Math.max(...candidates.map((id) => this.state.startingRoll.rolls[id]));
    const leaders = candidates.filter((id) => this.state.startingRoll.rolls[id] === highest);

    if (leaders.length > 1) {
      this.state.startingRoll = {
        round: this.state.startingRoll.round + 1,
        candidatePlayerIds: leaders,
        rolls: {},
      };
      events.push(
        this.event(LudoRuntimeEventType.STARTING_ROLL_TIE, {
          round: this.state.startingRoll.round,
          candidatePlayerIds: [...leaders],
        }),
      );
      return events;
    }

    const starter = leaders[0];
    game.phase = LudoMatchPhase.PLAYING;
    game.turnPhase = LudoTurnPhase.WAITING_FOR_ROLL;
    game.currentPlayerId = starter;
    game.diceValue = null;
    game.legalTokenIds = [];
    game.consecutiveSixes = 0;

    events.push(
      this.event(LudoRuntimeEventType.MATCH_STARTED, { playerId: starter }),
      this.event(LudoRuntimeEventType.TURN_STARTED, { playerId: starter }),
    );
    return events;
  }

  private rollDice(command: RollDiceCommand): LudoRuntimeEvent[] {
    const game = this.state.game;
    this.assertPlayingTurn(command.playerId, LudoTurnPhase.WAITING_FOR_ROLL);

    const value = this.dice.roll();
    game.version += 1;
    game.diceValue = value;
    game.legalTokenIds = [];

    const events: LudoRuntimeEvent[] = [
      this.event(LudoRuntimeEventType.DICE_ROLLED, {
        playerId: command.playerId,
        diceValue: value,
      }),
    ];

    if (value === 6) {
      const nextSixCount = game.consecutiveSixes + 1;
      if (nextSixCount >= this.rules.maxConsecutiveSixes) {
        game.consecutiveSixes = 0;
        events.push(
          this.event(LudoRuntimeEventType.THIRD_SIX_FORFEITED, {
            playerId: command.playerId,
            diceValue: value,
          }),
        );
        this.advanceTurn(events);
        return events;
      }
      game.consecutiveSixes = nextSixCount;
    } else {
      game.consecutiveSixes = 0;
    }

    const legalTokenIds = this.engine.getLegalTokenIds(game, command.playerId, value);
    game.legalTokenIds = [...legalTokenIds];

    if (legalTokenIds.length === 0) {
      events.push(
        this.event(LudoRuntimeEventType.NO_LEGAL_MOVE, {
          playerId: command.playerId,
          diceValue: value,
        }),
      );

      if (value === 6 && this.rules.sixGrantsExtraRoll) {
        game.turnPhase = LudoTurnPhase.WAITING_FOR_ROLL;
        game.diceValue = null;
        events.push(
          this.event(LudoRuntimeEventType.EXTRA_ROLL_GRANTED, { playerId: command.playerId }),
        );
      } else {
        this.advanceTurn(events);
      }
      return events;
    }

    game.turnPhase = LudoTurnPhase.WAITING_FOR_MOVE;

    // Only one possible move: play it now (popular rules) instead of making
    // the player tap. Same command, so it is atomic and versions stay ordered.
    if (legalTokenIds.length === 1 && this.rules.autoMoveSingleLegal) {
      return [
        ...events,
        ...this.moveToken({
          type: 'MOVE_TOKEN',
          commandId: command.commandId,
          playerId: command.playerId,
          expectedVersion: game.version,
          tokenId: legalTokenIds[0],
        }),
      ];
    }

    events.push(
      this.event(LudoRuntimeEventType.LEGAL_MOVES_READY, {
        playerId: command.playerId,
        tokenIds: [...legalTokenIds],
        legalMoves: this.engine.previewMoves(game, command.playerId, value),
      }),
    );
    return events;
  }

  private moveToken(command: MoveTokenCommand): LudoRuntimeEvent[] {
    const game = this.state.game;
    this.assertPlayingTurn(command.playerId, LudoTurnPhase.WAITING_FOR_MOVE);
    if (game.diceValue === null) throw new Error('DICE_NOT_ROLLED');
    if (!game.legalTokenIds.includes(command.tokenId)) throw new Error('ILLEGAL_LUDO_MOVE');

    const diceValue = game.diceValue;
    const beforeFinished = this.playerFinished(command.playerId);
    const result = this.engine.move(game, command.playerId, command.tokenId, diceValue);
    this.state.game = result.state;
    const next = this.state.game;
    next.diceValue = null;
    next.legalTokenIds = [];

    const events: LudoRuntimeEvent[] = [
      this.event(LudoRuntimeEventType.TOKEN_MOVED, {
        playerId: command.playerId,
        tokenId: command.tokenId,
        move: result.resolution,
      }),
    ];

    if (result.resolution.capturedTokenIds.length > 0) {
      events.push(
        this.event(LudoRuntimeEventType.TOKEN_CAPTURED, {
          playerId: command.playerId,
          tokenId: command.tokenId,
          tokenIds: [...result.resolution.capturedTokenIds],
        }),
      );
    }

    if (result.resolution.tokenAfter.state === LudoTokenState.FINISHED) {
      events.push(
        this.event(LudoRuntimeEventType.TOKEN_FINISHED, {
          playerId: command.playerId,
          tokenId: command.tokenId,
        }),
      );
    }

    const nowFinished = this.playerFinished(command.playerId);
    if (!beforeFinished && nowFinished && !next.winnerOrder.includes(command.playerId)) {
      next.winnerOrder.push(command.playerId);
      events.push(this.event(LudoRuntimeEventType.PLAYER_FINISHED, { playerId: command.playerId }));
    }

    if (this.tryFinishMatch(events)) return events;

    const rules = this.rules;
    const earnedExtraRoll =
      (diceValue === 6 && rules.sixGrantsExtraRoll) ||
      (result.resolution.capturedTokenIds.length > 0 && rules.captureGrantsExtraRoll) ||
      (result.resolution.tokenAfter.state === LudoTokenState.FINISHED && rules.finishGrantsExtraRoll);
    const mayRollAgain = earnedExtraRoll && !nowFinished && !this.state.resignedPlayerIds.includes(command.playerId);

    if (mayRollAgain) {
      next.turnPhase = LudoTurnPhase.WAITING_FOR_ROLL;
      events.push(
        this.event(LudoRuntimeEventType.EXTRA_ROLL_GRANTED, { playerId: command.playerId }),
      );
      return events;
    }

    this.advanceTurn(events);
    return events;
  }

  private resign(command: ResignCommand): LudoRuntimeEvent[] {
    const game = this.state.game;
    if (game.phase !== LudoMatchPhase.PLAYING) throw new Error('MATCH_NOT_PLAYING');
    if (!game.players.some((player) => player.userId === command.playerId))
      throw new Error('PLAYER_NOT_IN_MATCH');
    if (this.state.resignedPlayerIds.includes(command.playerId))
      throw new Error('PLAYER_ALREADY_RESIGNED');
    if (game.winnerOrder.includes(command.playerId))
      throw new Error('FINISHED_PLAYER_CANNOT_RESIGN');

    game.version += 1;
    this.state.resignedPlayerIds.push(command.playerId);
    const events: LudoRuntimeEvent[] = [
      this.event(LudoRuntimeEventType.PLAYER_RESIGNED, { playerId: command.playerId }),
    ];

    if (this.tryFinishMatch(events)) return events;

    if (game.currentPlayerId === command.playerId) this.advanceTurn(events);
    return events;
  }

  private assertPlayingTurn(playerId: string, requiredPhase: LudoTurnPhase): void {
    const game = this.state.game;
    if (game.phase !== LudoMatchPhase.PLAYING) throw new Error('MATCH_NOT_PLAYING');
    if (game.currentPlayerId !== playerId) throw new Error('NOT_PLAYER_TURN');
    if (game.turnPhase !== requiredPhase) throw new Error('INVALID_TURN_PHASE');
    if (this.state.resignedPlayerIds.includes(playerId)) throw new Error('PLAYER_RESIGNED');
    if (game.winnerOrder.includes(playerId)) throw new Error('PLAYER_ALREADY_FINISHED');
  }

  private activePlayerIds(): string[] {
    const excluded = new Set([...this.state.game.winnerOrder, ...this.state.resignedPlayerIds]);
    return this.state.game.players.map((player) => player.userId).filter((id) => !excluded.has(id));
  }

  private advanceTurn(events: LudoRuntimeEvent[]): void {
    const game = this.state.game;
    const active = this.activePlayerIds();
    if (active.length === 0) {
      this.tryFinishMatch(events);
      return;
    }

    const playerOrder = game.players.map((player) => player.userId);
    const currentIndex =
      game.currentPlayerId === null ? -1 : playerOrder.indexOf(game.currentPlayerId);
    let nextPlayerId: string | null = null;
    for (let step = 1; step <= playerOrder.length; step += 1) {
      const candidate =
        playerOrder[(currentIndex + step + playerOrder.length) % playerOrder.length];
      if (active.includes(candidate)) {
        nextPlayerId = candidate;
        break;
      }
    }
    if (!nextPlayerId) throw new Error('NO_ACTIVE_PLAYER');

    game.currentPlayerId = nextPlayerId;
    game.turnPhase = LudoTurnPhase.WAITING_FOR_ROLL;
    game.diceValue = null;
    game.legalTokenIds = [];
    game.consecutiveSixes = 0;
    events.push(this.event(LudoRuntimeEventType.TURN_STARTED, { playerId: nextPlayerId }));
  }

  private tryFinishMatch(events: LudoRuntimeEvent[]): boolean {
    const game = this.state.game;
    const active = this.activePlayerIds();
    if (active.length > 1) return false;

    if (active.length === 1 && !game.winnerOrder.includes(active[0])) {
      game.winnerOrder.push(active[0]);
    }

    // Resigned players rank behind players that remained active. Reverse resign
    // order means the earliest resignation is last.
    const resignedRanking = [...this.state.resignedPlayerIds].reverse();
    for (const playerId of resignedRanking) {
      if (!game.winnerOrder.includes(playerId)) game.winnerOrder.push(playerId);
    }

    // Defensive fallback for malformed/recovered states: every participant must
    // appear exactly once in the final ranking.
    for (const player of game.players) {
      if (!game.winnerOrder.includes(player.userId)) game.winnerOrder.push(player.userId);
    }

    game.phase = LudoMatchPhase.FINISHED;
    game.turnPhase = LudoTurnPhase.COMPLETE;
    game.currentPlayerId = null;
    game.diceValue = null;
    game.legalTokenIds = [];
    game.consecutiveSixes = 0;
    events.push(
      this.event(LudoRuntimeEventType.MATCH_FINISHED, {
        winnerOrder: [...game.winnerOrder],
      }),
    );
    return true;
  }

  private playerFinished(playerId: string): boolean {
    const player = this.state.game.players.find((item) => item.userId === playerId);
    if (!player) throw new Error('PLAYER_NOT_IN_MATCH');
    return player.tokens.every((token) => token.state === LudoTokenState.FINISHED);
  }

  private event(
    type: LudoRuntimeEventType,
    data: Omit<LudoRuntimeEvent, 'type' | 'matchId' | 'version'> = {},
  ): LudoRuntimeEvent {
    return {
      type,
      matchId: this.state.game.matchId,
      version: this.state.game.version,
      ...data,
    };
  }

  private assertRuntimeState(): void {
    assertValidLudoState(this.state.game);
    const playerIds = this.state.game.players.map((player) => player.userId);
    const playerSet = new Set(playerIds);
    for (const id of this.state.startingRoll.candidatePlayerIds) {
      if (!playerSet.has(id)) throw new Error('Invalid starting-roll candidate.');
    }
    for (const id of Object.keys(this.state.startingRoll.rolls)) {
      if (!this.state.startingRoll.candidatePlayerIds.includes(id)) {
        throw new Error('Starting roll exists for a non-candidate.');
      }
    }
    for (const id of this.state.resignedPlayerIds) {
      if (!playerSet.has(id)) throw new Error('Invalid resigned player.');
    }
    if (new Set(this.state.resignedPlayerIds).size !== this.state.resignedPlayerIds.length) {
      throw new Error('Duplicate resigned player.');
    }
    if (new Set(this.state.game.winnerOrder).size !== this.state.game.winnerOrder.length) {
      throw new Error('Duplicate winner ranking.');
    }
  }
}
