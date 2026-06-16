/**
 * resolveAuxKey — pick the pool key for the background/aux client. The unified
 * store's settings.defaults.auxText (a connection id, which is also the pool
 * key) wins; the legacy settings.auxModelKey is the fallback. Empty strings are
 * treated as unset. See docs/.../2026-06-15-unified-model-catalog-design.md §6.
 */
export function resolveAuxKey(settings: {
  defaults?: { auxText?: string };
  auxModelKey?: string;
}): string | undefined {
  const unified = settings.defaults?.auxText;
  if (unified) return unified;
  const legacy = settings.auxModelKey;
  if (legacy) return legacy;
  return undefined;
}
