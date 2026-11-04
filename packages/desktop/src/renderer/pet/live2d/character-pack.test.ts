import { describe, expect, test } from "bun:test";
import {
  companionFeetOffset,
  MIMI_APPEARANCES,
  type MimiCompanionState,
} from "../../../shared/mimi-companion";
import pack from "../../assets/mimi-papillon/performer-pack.json";
import makiPoses from "../../assets/maki/poses.json";
import shiroPoses from "../../assets/shiro/poses.json";
import {
  packCueMs,
  packFacesLeft,
  packFrameStyle,
  packMove,
  parseCharacterPack,
  type CharacterPack,
} from "./character-pack";
import {
  parsePoseLibrary,
  poseBehavior,
  poseLayout,
  posePick,
  POSE_NAMES,
  type PoseLibrary,
} from "./pose-library";
import { CHARACTER_RENDERERS } from "./MimiCompanionWindow";
import { SPRITE_CHARACTERS, spriteCharacter } from "./sprite-characters";

const bundled = parseCharacterPack(pack);

function state(patch: Partial<MimiCompanionState>): MimiCompanionState {
  return {
    enabled: true,
    visible: true,
    appearance: "mimi-sprite",
    size: 176,
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

const poseState: MimiCompanionState = {
  enabled: true,
  visible: true,
  size: 200,
  appearance: "shiro-sprite",
  position: { x: 100, y: 100 },
  activity: { id: "a1", action: "idle", phase: "start", startedAt: 0 },
  preview: false,
};
const act = (action: MimiCompanionState["activity"]["action"], extra = {}) => ({
  ...poseState,
  ...extra,
  activity: { ...poseState.activity, action },
});

const library: PoseLibrary = parsePoseLibrary({
  version: 1,
  head: 0.4,
  surfaceScale: 1.5,
  poses: {
    stand: {
      file: "stand.webp",
      width: 200,
      height: 400,
      head: 100,
      anchor: { x: 100, y: 400 },
      facing: "front",
    },
    kick: {
      file: "kick.webp",
      width: 400,
      height: 400,
      head: 100,
      anchor: { x: 100, y: 400 },
      contact: { x: 380, y: 100 },
      facing: "right",
      sfx: "咚!",
    },
    "lie-ledge": {
      file: "lie.webp",
      width: 600,
      height: 200,
      head: 100,
      anchor: { x: 300, y: 190 },
      facing: "right",
    },
  },
});

describe("pose library", () => {
  test("the bundled Shiro library parses and covers every pose", () => {
    const parsed = parsePoseLibrary(shiroPoses);
    expect(Object.keys(parsed.poses).sort()).toEqual([
      "cheer",
      "dash",
      "fail",
      "kick",
      "lie-ledge",
      "look",
      "point",
      "sit-ledge",
      "stand",
      "stomp",
    ]);
  });

  test("rejects unknown poses, anchors outside the image and a missing head", () => {
    const pose = {
      file: "a.webp",
      width: 10,
      height: 10,
      head: 5,
      anchor: { x: 5, y: 10 },
      facing: "front",
    };
    expect(() =>
      parsePoseLibrary({ version: 1, head: 0.3, surfaceScale: 1, poses: { fly: pose } }),
    ).toThrow();
    expect(() =>
      parsePoseLibrary({
        version: 1,
        head: 0.3,
        surfaceScale: 1,
        poses: { stand: { ...pose, anchor: { x: 5, y: 11 } } },
      }),
    ).toThrow();
    expect(() =>
      parsePoseLibrary({
        version: 1,
        head: 0.3,
        surfaceScale: 1,
        poses: { stand: { ...pose, contact: { x: 99, y: 1 } } },
      }),
    ).toThrow();
    expect(() => parsePoseLibrary({ version: 1, surfaceScale: 1, poses: {} })).toThrow();
  });

  test("picks by surface and action, falling back to what the library has", () => {
    expect(posePick(library, { ...poseState, perch: "title-bar" }, false, null)).toBe("lie-ledge");
    expect(
      posePick(library, act("click", { perch: "on-baseline", element: "button" }), true, null),
    ).toBe("kick");
    // Nothing for a plain click here: the base atlas plays it.
    expect(posePick(library, act("click", { element: "other" }), true, null)).toBeUndefined();
    expect(posePick(library, act("complete"), true, null)).toBe("stand");
    // Moving without a dash pose leaves the moment to the base atlas.
    expect(posePick(library, poseState, false, "left")).toBeUndefined();
  });

  test("the anchor sits on the feet line in the middle of the box, head-sized", () => {
    const layout = poseLayout(library, library.poses.stand!, poseState, false);
    const k = (200 * 0.4) / 100;
    expect(layout.width).toBeCloseTo(200 * k);
    expect(layout.left + 100 * k).toBeCloseTo(70);
    expect(layout.bottom).toBeCloseTo(companionFeetOffset(200));
  });

  test("on a control the pose stays larger than the shrunk box", () => {
    const free = poseLayout(library, library.poses.stand!, poseState, false);
    const working = poseLayout(
      library,
      library.poses.stand!,
      { ...poseState, perch: "on-baseline" },
      false,
    );
    expect(working.height / free.height).toBeCloseTo(1.5);
  });

  test("a strike puts the contact pixel on the target, mirrored toward a target on the left", () => {
    const target = { x: 400, y: 160 };
    const right = poseLayout(library, library.poses.kick!, { ...poseState, target }, false, true);
    const k = right.width / 400;
    expect(right.left + 380 * k).toBeCloseTo(target.x - poseState.position.x);
    expect(200 - right.bottom - (400 - 100) * k).toBeCloseTo(target.y - poseState.position.y);
    const left = poseLayout(
      library,
      library.poses.kick!,
      { ...poseState, target: { x: 20, y: 160 } },
      true,
      true,
    );
    expect(left.flip).toBe(true);
    expect(left.left + (400 - 380) * k).toBeCloseTo(20 - poseState.position.x);
    // Not striking: back on the feet line.
    expect(
      poseLayout(library, library.poses.kick!, { ...poseState, target }, false).bottom,
    ).toBeCloseTo(companionFeetOffset(200));
  });

  test("Maki covers every shared moment and only names poses she has", () => {
    const parsed = parsePoseLibrary(makiPoses);
    for (const name of POSE_NAMES) expect(parsed.poses[name]).toBeDefined();
    for (const list of Object.values(parsed.behaviors ?? {}))
      for (const name of list ?? []) expect(parsed.poses[name]).toBeDefined();
    expect(parsed.behaviors?.idle?.length).toBeGreaterThan(1);
  });

  test("a character's own poses must be used by a behavior that exists", () => {
    const pose = library.poses.stand!;
    const base = { version: 1, head: 0.3, surfaceScale: 1 };
    expect(
      parsePoseLibrary({
        ...base,
        poses: { stand: pose, piano: pose },
        behaviors: { idle: ["piano"] },
      }).behaviors?.idle,
    ).toEqual(["piano"]);
    // Unused, missing, or under an unknown behavior: a build error.
    expect(() => parsePoseLibrary({ ...base, poses: { stand: pose, piano: pose } })).toThrow();
    expect(() =>
      parsePoseLibrary({ ...base, poses: { stand: pose }, behaviors: { idle: ["piano"] } }),
    ).toThrow();
    expect(() =>
      parsePoseLibrary({
        ...base,
        poses: { stand: pose, piano: pose },
        behaviors: { dance: ["piano"] },
      }),
    ).toThrow();
  });

  test("completion and errors vary per beat but keep the variant they started with", () => {
    const pose = library.poses.stand!;
    const own = parsePoseLibrary({
      version: 1,
      head: 0.3,
      surfaceScale: 1,
      poses: { stand: pose, cheer: pose, wink: pose, fail: pose, pout: pose },
      behaviors: { complete: ["wink"], error: ["pout"] },
    });
    const done = (id: string) =>
      posePick(
        own,
        { ...act("complete"), activity: { ...act("complete").activity, id } },
        true,
        null,
      );
    const seen = new Set(Array.from({ length: 40 }, (_, index) => done(`run-${index}`)));
    expect([...seen].sort()).toEqual(["cheer", "wink"]);
    expect(done("run-7")).toBe(done("run-7"));
    expect(["fail", "pout"]).toContain(posePick(own, act("error"), true, null)!);
    // Without her own variants the shared pose is the only choice.
    expect(posePick(library, act("complete"), true, null)).toBe("stand");
    expect(poseBehavior(own, "complete", 3)).toBe("wink");
    expect(poseBehavior(library, "idle", 3)).toBeUndefined();
  });

  test("every selectable appearance draws its own character", () => {
    for (const appearance of MIMI_APPEARANCES) {
      expect(spriteCharacter(appearance)).toBe(SPRITE_CHARACTERS[appearance]);
      expect(CHARACTER_RENDERERS[appearance]?.id).toBe(appearance);
    }
    expect(spriteCharacter("maki-sprite").name).toBe("Maki");
  });
});
