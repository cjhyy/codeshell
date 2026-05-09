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

/**
 * Short, human-readable turn correlation ID. Stamped on every log entry
 * written for the duration of one turn so `jq 'select(.turnId == "abc123")'`
 * pulls a single turn's whole timeline out of the daily log file.
 */
export function newTurnId(): string {
  return `t${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
