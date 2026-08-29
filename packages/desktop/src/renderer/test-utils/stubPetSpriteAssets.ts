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

/** Register a harmless string for every sprite asset petSprite imports. */
export function stubPetSpriteAssets(): void {
  for (const specifier of PET_SPRITE_ASSET_SPECIFIERS) {
    mock.module(specifier, () => ({ default: "sprite.png" }));
  }
}
