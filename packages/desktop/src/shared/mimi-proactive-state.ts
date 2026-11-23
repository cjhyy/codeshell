import type { BriefKind, PetProactiveState } from "../main/pet/pet-proactive-state.js";

/** Daily counts and cursor changes are applied to the current state under one writer. */
export type MimiProactiveChange =
  | { type: "markBrief"; kind: BriefKind; at: number; day: number }
  | { type: "reserveJudgement"; day: number; since: number }
  | { type: "advance"; day: number; at: number; seen: string[]; said: boolean };
export type MimiProactiveCommand = { type: "read" } | MimiProactiveChange;
export type MimiProactiveReply = { state: PetProactiveState } | { committed: boolean };
export interface MimiProactiveAccess {
  read(): Promise<PetProactiveState>;
  change(input: MimiProactiveChange): Promise<boolean>;
}
