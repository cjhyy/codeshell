/**
 * resolveAuxKey — pick the pool key for the background/aux client. Reads the
 * unified store's settings.defaults.auxText (a connection id, also the pool
 * key). Empty strings are treated as unset. (legacy settings.auxModelKey 已删除)
 */
export function resolveAuxKey(settings: {
  defaults?: { auxText?: string };
}): string | undefined {
  const unified = settings.defaults?.auxText;
  if (unified) return unified;
  return undefined;
}
