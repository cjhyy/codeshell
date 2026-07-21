/**
 * Map worker-side resource notifications onto the renderer's existing local
 * invalidation bus. Kept transport-only: preload does not load settings itself.
 */
export function forwardAgentSideEffectEvent(
  method: string | undefined,
  dispatch: (eventName: "codeshell:settings-changed") => void,
): boolean {
  if (method !== "agent/settingsChanged") return false;
  dispatch("codeshell:settings-changed");
  return true;
}
