/**
 * NoneProvider — returns no external evidence.
 * Used for pure topic discussions, brainstorming, or debates
 * where no external context is needed.
 */

import type { ArenaPlan, ArenaArtifact, ArenaContextProvider } from "../types.js";

export const noneProvider: ArenaContextProvider = {
  kind: "none",

  collect(_plan: ArenaPlan, _topic: string): ArenaArtifact[] {
    return [];
  },
};
