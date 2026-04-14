/**
 * Turn loop state definitions.
 */

import type { TurnPhase, ToolCall, LLMResponse, TerminalReason } from "../types.js";

export interface TurnState {
  phase: TurnPhase;
  turnNumber: number;
  modelResponse?: LLMResponse;
  toolCalls?: ToolCall[];
  finalText?: string;
  error?: Error;
  terminalReason?: TerminalReason;
}

export function initialTurnState(turnNumber: number): TurnState {
  return {
    phase: "pre_check",
    turnNumber,
  };
}
