import { DiceProvider, FixedDiceProvider, SeededDiceProvider } from '../dice';
import { LudoGameState, LudoMatchPhase, LudoTurnPhase, assertValidLudoState } from '../domain';
import { LudoEngine } from '../engine';
import { LudoMatchRuntime, LudoRuntimeCommand, LudoRuntimeEventType } from '../runtime';
import { LudoBot } from './bots';

export type ReplayAction =
  | { type: 'ROLL_FOR_START'; playerId: string; commandId: string }
  | { type: 'ROLL_DICE'; playerId: string; commandId: string }
  | { type: 'MOVE_TOKEN'; playerId: string; tokenId: string; commandId: string }
  | { type: 'RESIGN'; playerId: string; commandId: string };

export type LudoSimulationResult = {
  matchId: string;
  playerIds: string[];
  winnerOrder: string[];
  finalState: LudoGameState;
  finalVersion: number;
  commandsExecuted: number;
  diceRolls: number[];
  transcript: ReplayAction[];
};

class RecordingDiceProvider implements DiceProvider {
  readonly rolls: number[] = [];
  constructor(private readonly inner: DiceProvider) {}
  roll(): number {
    const value = this.inner.roll();
    this.rolls.push(value);
    return value;
  }
}

function commandFromAction(action: ReplayAction, expectedVersion: number): LudoRuntimeCommand {
  switch (action.type) {
    case 'ROLL_FOR_START':
      return { ...action, expectedVersion };
    case 'ROLL_DICE':
      return { ...action, expectedVersion };
    case 'MOVE_TOKEN':
      return { ...action, expectedVersion };
    case 'RESIGN':
      return { ...action, expectedVersion };
  }
}

export function simulateLudoMatch(options: {
  matchId: string;
  playerIds: string[];
  bots: Record<string, LudoBot>;
  dice?: DiceProvider;
  seed?: string;
  maxCommands?: number;
}): LudoSimulationResult {
  const recordingDice = new RecordingDiceProvider(
    options.dice ?? new SeededDiceProvider(options.seed ?? options.matchId),
  );
  const runtime = new LudoMatchRuntime(options.matchId, options.playerIds, recordingDice);
  const engine = new LudoEngine();
  const transcript: ReplayAction[] = [];
  const maxCommands = options.maxCommands ?? 20_000;
  let commandCounter = 0;

  const execute = (action: ReplayAction): void => {
    if (commandCounter >= maxCommands) throw new Error('SIMULATION_COMMAND_LIMIT_EXCEEDED');
    const expectedVersion = runtime.getState().game.version;
    runtime.execute(commandFromAction(action, expectedVersion));
    transcript.push(action);
    commandCounter += 1;
    assertValidLudoState(runtime.getState().game);
  };

  while (runtime.getState().game.phase !== LudoMatchPhase.FINISHED) {
    const state = runtime.getState();
    const game = state.game;

    if (game.phase === LudoMatchPhase.PRE_GAME) {
      const pending = state.startingRoll.candidatePlayerIds.filter(
        (id) => state.startingRoll.rolls[id] === undefined,
      );
      if (pending.length === 0) throw new Error('STARTING_ROLL_STALLED');
      for (const playerId of pending) {
        execute({
          type: 'ROLL_FOR_START',
          playerId,
          commandId: `sim-${commandCounter + 1}`,
        });
      }
      continue;
    }

    if (game.currentPlayerId === null) throw new Error('PLAYING_WITHOUT_CURRENT_PLAYER');
    const playerId = game.currentPlayerId;

    if (game.turnPhase === LudoTurnPhase.WAITING_FOR_ROLL) {
      execute({ type: 'ROLL_DICE', playerId, commandId: `sim-${commandCounter + 1}` });
      continue;
    }

    if (game.turnPhase === LudoTurnPhase.WAITING_FOR_MOVE) {
      if (game.diceValue === null || game.legalTokenIds.length === 0) {
        throw new Error('WAITING_FOR_MOVE_WITHOUT_LEGAL_MOVE');
      }
      const legalMoves = engine.getLegalMoves(game, playerId, game.diceValue);
      const bot = options.bots[playerId];
      if (!bot) throw new Error(`Missing bot for ${playerId}.`);
      const chosen = bot.chooseMove(game, playerId, game.diceValue, legalMoves);
      if (!game.legalTokenIds.includes(chosen.tokenId)) throw new Error('BOT_CHOSE_ILLEGAL_MOVE');
      execute({
        type: 'MOVE_TOKEN',
        playerId,
        tokenId: chosen.tokenId,
        commandId: `sim-${commandCounter + 1}`,
      });
      continue;
    }

    throw new Error(`SIMULATION_STALLED_AT_${game.turnPhase}`);
  }

  const final = runtime.getState().game;
  if (final.winnerOrder.length !== options.playerIds.length) throw new Error('INCOMPLETE_WINNER_ORDER');
  if (new Set(final.winnerOrder).size !== options.playerIds.length) throw new Error('DUPLICATE_WINNER_ORDER');

  return {
    matchId: options.matchId,
    playerIds: [...options.playerIds],
    winnerOrder: [...final.winnerOrder],
    finalState: final,
    finalVersion: final.version,
    commandsExecuted: commandCounter,
    diceRolls: [...recordingDice.rolls],
    transcript,
  };
}

export function replayLudoSimulation(result: LudoSimulationResult): void {
  const runtime = new LudoMatchRuntime(
    result.matchId,
    result.playerIds,
    new FixedDiceProvider(result.diceRolls),
  );

  for (const action of result.transcript) {
    runtime.execute(commandFromAction(action, runtime.getState().game.version));
  }

  const final = runtime.getState().game;
  assertValidLudoState(final);
  if (final.version !== result.finalVersion) throw new Error('REPLAY_VERSION_MISMATCH');
  if (JSON.stringify(final) !== JSON.stringify(result.finalState)) {
    throw new Error('REPLAY_FINAL_STATE_MISMATCH');
  }
}

export function countRuntimeEvents(
  runtime: LudoMatchRuntime,
  command: LudoRuntimeCommand,
  type: LudoRuntimeEventType,
): number {
  return runtime.execute(command).events.filter((event) => event.type === type).length;
}
