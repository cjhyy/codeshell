import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PET_SPRITE_ASSET_SPECIFIERS, stubValueFor } from "./stubPetSpriteAssets";

describe("pet sprite asset stubs", () => {
  test("cover every asset petSprite imports", () => {
    const source = readFileSync(join(import.meta.dir, "..", "petSprite.ts"), "utf8");
    const imported = [...source.matchAll(/from\s+"(\.\/assets\/[^"]+)"/g)]
      .map((match) => match[1].replace(/^\.\//, "../"))
      .sort();

    // A new sprite import with no stub throws while the module graph loads, so
    // every suite that mounts the app dies before running a single test.
    expect([...PET_SPRITE_ASSET_SPECIFIERS].sort()).toEqual(imported);
  });
});

describe("stub values are distinguishable", () => {
  test("every asset gets its own value", () => {
    // A single shared "sprite.png" made left and right walk frames compare
    // equal, so petSprite's own test failed — but only in CI, where file order
    // put a stubbing suite before it. mock.module rewrites the registry for the
    // whole process, so the stub must preserve the one property petSprite
    // asserts on: that different assets are different.
    const values = PET_SPRITE_ASSET_SPECIFIERS.map(stubValueFor);
    expect(new Set(values).size).toBe(values.length);
  });

  test("left and right frames stay distinguishable", () => {
    expect(stubValueFor("../assets/mimi-papillon/run-left-1.png")).not.toBe(
      stubValueFor("../assets/mimi-papillon/run-right-1.png"),
    );
  });
});
