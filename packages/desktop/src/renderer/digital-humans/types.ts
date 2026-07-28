import type { DigitalHumanTeamMode } from "../../shared/digital-human-team";

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
  /**
   * true → 独占工作面：未声明的能力被显式关掉，而非与用户已开启的取并集。
   * schema 侧有 default(false)，故解析后必有值；旧数据经 schema 归一化。
   */
  exclusiveCapabilities: boolean;
  version?: string;
  /**
   * Dependency declaration (skill sources + required binaries). The editor has
   * no field for it but must round-trip it on save, otherwise editing a
   * repo-installed digital human strips the very thing that makes it work.
   */
  requires?: {
    skills: Array<{
      source: "github";
      repo: string;
      skills?: string[];
      scope: "project";
      fullDepth: boolean;
    }>;
    tools: Array<{ bin: string; minVersion?: string; hint?: string }>;
  };
}

export interface DigitalHumanSkillEntry {
  name: string;
  description: string;
  source: "project" | "user" | "plugin";
}

export interface DigitalHumanCatalogEntry extends Omit<DigitalHumanProfileEntry, "active"> {
  category: "product" | "design" | "engineering" | "quality";
  tags: string[];
  samplePrompts: string[];
  /** Set when the entry came from a registered digital-human repo. */
  sourceRepo?: string;
  installed: boolean;
}

export interface CuratedDigitalHumanTeam {
  id: string;
  name: string;
  description: string;
  category: DigitalHumanCatalogEntry["category"];
  tags: string[];
  members: string[];
  mode: DigitalHumanTeamMode;
  samplePrompts: string[];
}
