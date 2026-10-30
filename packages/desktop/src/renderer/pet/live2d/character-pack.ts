import { COMPANION_CELL, type MimiCompanionState } from "../../../shared/mimi-companion";

/** Moves a character pack can add on top of the base atlas. Each is bound to
 * a surface the stage model put the character on (see stage-model). */
export const PACK_MOVES = ["sit-type", "kick", "poke", "lie-wait"] as const;
export type PackMoveName = (typeof PACK_MOVES)[number];

export interface PackMove {
  row: number;
  frames: number;
  frameMs: number;
  /** Loops while its operation runs; otherwise plays once and holds. */
  loop: boolean;
  /** Frame on which the paw or foot meets the target. */
  contact?: number;
  /** Where the feet (or seat, or belly) rest in this row's cells. */
  feetY: number;
  /** Drawn size relative to the base atlas, so the head stays the same size. */
  scale: number;
  /** "right" art is mirrored to face a target on the left. */
  facing: "front" | "right";
}

/** A data-only character pack: one atlas of 192x208 cells plus its moves.
 * See docs/superpowers/specs/2026-10-30-mimi-character-pack-guideline.md. */
export interface CharacterPack {
  version: 1;
  atlas: string;
  columns: number;
  rows: number;
  cell: { width: number; height: number };
  moves: Partial<Record<PackMoveName, PackMove>>;
}

const int = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && (value as number) >= min && (value as number) <= max;

/** Strict: a pack that does not fit its own atlas is a build error. */
export function parseCharacterPack(raw: unknown): CharacterPack {
  const pack = raw as CharacterPack;
  if (!pack || pack.version !== 1 || typeof pack.atlas !== "string")
    throw new Error("character pack: version 1 with an atlas is required");
  if (!int(pack.columns, 1, 16) || !int(pack.rows, 1, 32))
    throw new Error("character pack: invalid grid");
  if (pack.cell?.width !== COMPANION_CELL.width || pack.cell?.height !== COMPANION_CELL.height)
    throw new Error("character pack: cells must be 192x208");
  const moves: CharacterPack["moves"] = {};
  for (const [name, move] of Object.entries(pack.moves ?? {})) {
    if (!(PACK_MOVES as readonly string[]).includes(name))
      throw new Error(`character pack: unknown move ${name}`);
    if (
      !int(move.row, 0, pack.rows - 1) ||
      !int(move.frames, 1, pack.columns) ||
      !int(move.frameMs, 40, 1000) ||
      typeof move.loop !== "boolean" ||
      (move.contact !== undefined && !int(move.contact, 0, move.frames - 1)) ||
      !int(move.feetY, 1, COMPANION_CELL.height) ||
      typeof move.scale !== "number" ||
      !(move.scale >= 0.5 && move.scale <= 2) ||
      (move.facing !== "front" && move.facing !== "right")
    )
      throw new Error(`character pack: invalid move ${name}`);
    moves[name as PackMoveName] = move;
  }
  return { ...pack, moves };
}

/** The pack move for the current surface and action, if the pack has it.
 * Walking and floating placements keep the base atlas. */
export function packMove(
  pack: CharacterPack,
  state: MimiCompanionState,
  cueActive: boolean,
  moving: "left" | "right" | null,
): PackMoveName | undefined {
  if (moving) return;
  // Between actions on a window's top edge, lie along it and wait.
  if (!cueActive)
    return state.perch === "title-bar" && pack.moves["lie-wait"] ? "lie-wait" : undefined;
  const action = state.activity.action;
  let move: PackMoveName | undefined;
  if (state.perch === "on-field" && (action === "type" || action === "key" || action === "click"))
    move = "sit-type";
  else if (state.perch === "on-baseline" && action === "click")
    move = state.element === "link" ? "poke" : "kick";
  else if (state.perch === "title-bar" && action === "observe") move = "lie-wait";
  return move && pack.moves[move] ? move : undefined;
}

/** True when the target is left of the character's centre. */
export function packFacesLeft(state: MimiCompanionState): boolean {
  if (!state.target) return false;
  return state.target.x < state.position.x + (state.size * 0.7) / 2;
}

/** Background and transform that draw `frame` of `move` with its feet on the
 * base atlas's feet line, scaled about that line. */
export function packFrameStyle(
  pack: CharacterPack,
  move: PackMove,
  frame: number,
  facesLeft: boolean,
) {
  const { height, feetY: baseFeet } = COMPANION_CELL;
  const column = Math.min(frame, move.frames - 1);
  const flip = move.facing === "right" && facesLeft ? -1 : 1;
  const shift = (((baseFeet - move.feetY) * move.scale) / height) * 100;
  return {
    backgroundSize: `${pack.columns * 100}% ${pack.rows * 100}%`,
    backgroundPosition: `${(column / Math.max(1, pack.columns - 1)) * 100}% ${(move.row / Math.max(1, pack.rows - 1)) * 100}%`,
    transformOrigin: `50% ${(baseFeet / height) * 100}%`,
    transform: `translateY(${shift}%) scale(${flip * move.scale}, ${move.scale})`,
  };
}

/** One-shot cue length: every frame plus a short hold on the last. */
export function packCueMs(move: PackMove): number | undefined {
  return move.loop ? undefined : move.frames * move.frameMs + 200;
}
