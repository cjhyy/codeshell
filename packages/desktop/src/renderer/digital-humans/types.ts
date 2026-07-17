import type { DigitalHumanTeamMode } from "@cjhyy/code-shell-pet";

/**
 * Mirrors core's WorkspaceProfile persistence boundary. Renderer code cannot
 * runtime-import core packages, so keep these values aligned with
 * WORKSPACE_PROFILE_LIMITS.
 */
export const DIGITAL_HUMAN_PROFILE_LIMITS = {
  id: 64,
  label: 120,
  description: 4_096,
  basePreset: 128,
  mainInstruction: 32_768,
  version: 128,
  capabilityCount: 128,
  capabilityName: 256,
} as const;

export function canAddDigitalHumanSkill(selectedCount: number, name: string): boolean {
  return (
    selectedCount < DIGITAL_HUMAN_PROFILE_LIMITS.capabilityCount &&
    name.length > 0 &&
    name.length <= DIGITAL_HUMAN_PROFILE_LIMITS.capabilityName
  );
}

export type DigitalHumanSelection =
  | { kind: "single"; id: string; label: string }
  | {
      kind: "team";
      id: string;
      label: string;
      members: string[];
      mode: DigitalHumanTeamMode;
    };

export interface DigitalHumanProfileEntry {
  name: string;
  label: string;
  description?: string;
  basePreset: string;
  plugins: string[];
  skills: string[];
  mcp: string[];
  agents: string[];
  mainInstruction?: string;
  active: boolean;
  portableMemory: boolean;
  version?: string;
}

export interface DigitalHumanSkillEntry {
  name: string;
  description: string;
  source: "project" | "user" | "plugin";
}

export interface DigitalHumanCatalogEntry extends Omit<DigitalHumanProfileEntry, "active"> {
  category: "product" | "design" | "engineering" | "quality";
  tags: string[];
  installed: boolean;
}
