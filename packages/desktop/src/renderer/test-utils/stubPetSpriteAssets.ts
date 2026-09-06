import { mock } from "bun:test";

/**
 * `petSprite.ts` imports its sprite files as modules. Vite resolves those
 * through an asset loader, but the test runtime parses them as JavaScript and
 * throws while the module graph is still evaluating — before any test runs, so
 * the whole file reports one error instead of a failing assertion.
 *
 * Any suite that mounts the app transitively pulls petSprite in and needs these
 * stubs. They deliberately target the asset files rather than petSprite itself:
 * `mock.module` rewrites the registry for the entire `bun test` process, so
 * stubbing the module would hand petSprite's own tests a fake implementation.
 *
 * Keep this list in step with the imports in `renderer/petSprite.ts`; the unit
 * test beside this helper fails when they drift.
 */
export const PET_SPRITE_ASSET_SPECIFIERS = [
  "../assets/codeshell-dog-icon.png",
  "../assets/mimi-papillon/anim-jumping.webp",
  ...["left", "right"].flatMap((direction) =>
    [1, 2, 3, 4, 5, 6, 7, 8].map(
      (frame) => `../assets/mimi-papillon/run-${direction}-${frame}.png`,
    ),
  ),
] as const;

/**
 * The stub url for one asset — DISTINCT per asset, deliberately.
 *
 * A single shared value made every sprite compare equal, so petSprite's own
 * test ("left and right walk frames differ") failed whenever a stubbing suite
 * happened to run first. `mock.module` rewrites the registry for the whole
 * `bun test` process, so this stub reaches petSprite's tests too and must
 * preserve the property they assert on: different assets are different.
 *
 * That is why this was a CI-only failure — file order there put a stubbing
 * suite ahead of petSprite.test.ts; locally it ran the other way round.
 */
export function stubValueFor(specifier: string): string {
  return `stub:${specifier.replace(/^\.\.\//, "")}`;
}

/** Register a harmless, per-asset-unique string for every sprite import. */
export function stubPetSpriteAssets(): void {
  for (const specifier of PET_SPRITE_ASSET_SPECIFIERS) {
    mock.module(specifier, () => ({ default: stubValueFor(specifier) }));
  }
}
