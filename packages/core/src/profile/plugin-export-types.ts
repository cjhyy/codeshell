/** Static CC-lineage directory export. No Profile activation or installer authority. */
export const PROFILE_PLUGIN_EXPORT_LIMITS = {
  bytes: 4 * 1024 * 1024,
  files: 256,
  textBytes: 256 * 1024,
  depth: 8,
} as const;

export interface ProfilePluginExportSelection {
  componentIds: string[];
  textFileIds: string[];
  includeInstruction: boolean;
}

export interface ProfilePluginExportComponent {
  id: string;
  kind: "skill" | "agent";
  name: string;
  exportName: string;
  source?: "project" | "user" | "plugin";
  selected: boolean;
  blocked?: string;
  /** Relative paths only, from this Skill directory. Contents require explicit selection. */
  textFiles: Array<{ id: string; path: string; selected: boolean }>;
}

export interface ProfilePluginExportFile {
  path: string;
  text: string;
  bytes: number;
  sha256: string;
}

export interface ProfilePluginExportSnapshot {
  format: "codeshell-cc-static-v1";
  profileName: string;
  pluginName: string;
  components: ProfilePluginExportComponent[];
  losses: string[];
  files: ProfilePluginExportFile[];
  totalBytes: number;
  canExport: boolean;
}
