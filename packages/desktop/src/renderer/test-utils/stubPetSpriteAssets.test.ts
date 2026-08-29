import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PET_SPRITE_ASSET_SPECIFIERS } from "./stubPetSpriteAssets";

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
