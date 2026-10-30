import { describe, expect, test } from "bun:test";
import type { MimiCompanionState } from "../../../shared/mimi-companion";
import pack from "../../assets/mimi-papillon/performer-pack.json";
import {
  packCueMs,
  packFacesLeft,
  packFrameStyle,
  packMove,
  parseCharacterPack,
  type CharacterPack,
} from "./character-pack";

const bundled = parseCharacterPack(pack);

function state(patch: Partial<MimiCompanionState>): MimiCompanionState {
  return {
    enabled: true,
    visible: true,
    appearance: "mimi-sprite",
    size: 176,
    modelUrl: "",
    coreUrl: "",
    position: { x: 100, y: 100 },
    activity: { id: "a:1", action: "click", phase: "start", startedAt: 0 },
    ...patch,
  } as MimiCompanionState;
}

describe("character pack", () => {
  test("the bundled pack parses and every move fits its atlas", () => {
    for (const move of Object.values(bundled.moves)) {
      expect(move.row).toBeLessThan(bundled.rows);
      expect(move.frames).toBeLessThanOrEqual(bundled.columns);
      if (move.contact !== undefined) expect(move.contact).toBeLessThan(move.frames);
    }
  });

  test("rejects a pack whose move leaves its atlas", () => {
    const broken = structuredClone(pack) as Record<string, any>;
    broken.moves.kick.frames = 9;
    expect(() => parseCharacterPack(broken)).toThrow();
    expect(() => parseCharacterPack({ ...pack, version: 2 })).toThrow();
  });

  test("picks the move the surface and action call for", () => {
    const typing = state({
      perch: "on-field",
      activity: { ...state({}).activity, action: "type" },
    });
    expect(packMove(bundled, typing, true, null)).toBe("sit-type");
    expect(packMove(bundled, state({ perch: "on-baseline", element: "button" }), true, null)).toBe(
      "kick",
    );
    expect(packMove(bundled, state({ perch: "on-baseline", element: "link" }), true, null)).toBe(
      "poke",
    );
    const reading = state({
      perch: "title-bar",
      activity: { ...state({}).activity, action: "observe" },
    });
    expect(packMove(bundled, reading, true, null)).toBe("lie-wait");
    // Walking, idle, or floating beside a target keeps the base atlas.
    expect(packMove(bundled, state({ perch: "on-baseline" }), true, "left")).toBeUndefined();
    expect(packMove(bundled, state({ perch: "on-baseline" }), false, null)).toBeUndefined();
    expect(packMove(bundled, state({ perch: "beside-target" }), true, null)).toBeUndefined();
    // Idle on a window's top edge: lie along it.
    expect(packMove(bundled, state({ perch: "title-bar" }), false, null)).toBe("lie-wait");
  });

  test("a pack without a move falls back to the base atlas", () => {
    const partial: CharacterPack = { ...bundled, moves: { "sit-type": bundled.moves["sit-type"] } };
    expect(packMove(partial, state({ perch: "on-baseline" }), true, null)).toBeUndefined();
  });

  test("a right-facing move turns toward a target on the left", () => {
    expect(packFacesLeft(state({ target: { x: 40, y: 200 } }))).toBe(true);
    expect(packFacesLeft(state({ target: { x: 400, y: 200 } }))).toBe(false);
    expect(packFacesLeft(state({}))).toBe(false);
  });

  test("draws a frame with its feet on the base feet line, scaled about it", () => {
    const kick = bundled.moves.kick!;
    const style = packFrameStyle(bundled, kick, 2, false);
    expect(style.backgroundSize).toBe("800% 400%");
    expect(style.backgroundPosition).toBe(`${(2 / 7) * 100}% ${(1 / 3) * 100}%`);
    expect(style.transformOrigin).toBe(`50% ${(203 / 208) * 100}%`);
    // Feet at y=186 scaled 1.25 about y=203 land 21.25 cell px high; move them down.
    expect(style.transform).toBe(`translateY(${((17 * 1.25) / 208) * 100}%) scale(1.25, 1.25)`);
    expect(packFrameStyle(bundled, kick, 2, true).transform).toContain("scale(-1.25, 1.25)");
    // A front-facing move is never mirrored.
    expect(packFrameStyle(bundled, bundled.moves["sit-type"]!, 0, true).transform).toContain(
      "scale(1, 1)",
    );
  });

  test("a one-shot move's cue covers its frames and a short hold", () => {
    const kick = bundled.moves.kick!;
    expect(packCueMs(kick)).toBe(kick.frames * kick.frameMs + 200);
    expect(packCueMs(bundled.moves["sit-type"]!)).toBeUndefined();
  });
});
