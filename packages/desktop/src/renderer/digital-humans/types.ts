import type { DigitalHumanTeamMode } from "@cjhyy/code-shell-pet";

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
