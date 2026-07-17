/** Renderer-safe metadata for one installed plugin slash command. */
export interface PluginCommandDescriptor {
  /** Namespaced command without the leading slash, e.g. "superpowers:brainstorming". */
  name: string;
  pluginName: string;
  description: string;
  argumentHint?: string;
}

/** Result of expanding a plugin command in the trusted main process. */
export interface ExpandedPluginCommand {
  prompt: string;
}
