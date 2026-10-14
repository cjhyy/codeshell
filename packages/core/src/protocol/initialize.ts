import { CONTRACTS, type Contracts } from "../contracts.js";

/**
 * Result of the minimal `initialize` handshake (ch.16 §4.1).
 *
 * - Dispatch: AgentServer handles `initialize` after `moduleReady`, like every other
 *   request. S1 will report host-module capabilities, and ordering it with other
 *   requests avoids races.
 * - S0 ignores client params: there is no version negotiation until S1.
 * - `contracts` stays a top-level field permanently; S1 adds host/capabilities/methods
 *   alongside it.
 * - This file moves under `protocol/v2/` together with the S1 schema.
 */
export interface InitializeResult {
  protocolVersion: string;
  contracts: Contracts;
}

export function initializeResult(): InitializeResult {
  return { protocolVersion: CONTRACTS.agentProtocol.preferred, contracts: CONTRACTS };
}
