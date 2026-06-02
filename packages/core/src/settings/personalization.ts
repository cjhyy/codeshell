/** The agent.* subset of settings the Engine needs for personalization +
 * instruction-file compat. Hosts spread this into EngineConfig so the three
 * fields stay wired identically across desktop / TUI / TCP (avoids per-host drift). */
export interface PersonalizationConfig {
  responseLanguage?: string;
  userProfile?: string;
  instructions?: { compatClaude?: boolean; compatCodex?: boolean };
}

export function personalizationFrom(agent: {
  responseLanguage?: string;
  userProfile?: string;
  instructions?: { compatClaude?: boolean; compatCodex?: boolean };
}): PersonalizationConfig {
  return {
    responseLanguage: agent.responseLanguage,
    userProfile: agent.userProfile,
    instructions: agent.instructions,
  };
}
