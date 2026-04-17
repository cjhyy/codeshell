/**
 * Centralized tool progress types to break import cycles.
 * These types are re-exported from Tool.ts for backwards compatibility.
 */

export type BashProgress = {
  command?: string
  stdout?: string
  stderr?: string
  interrupted?: boolean
  exitCode?: number | null
}

export type AgentToolProgress = {
  agentName?: string
  status?: string
  output?: string
}

export type MCPProgress = {
  serverName?: string
  toolName?: string
  status?: string
}

export type REPLToolProgress = {
  language?: string
  output?: string
}

export type SkillToolProgress = {
  skillName?: string
  status?: string
}

export type TaskOutputProgress = {
  taskId?: string
  output?: string
}

export type WebSearchProgress = {
  query?: string
  results?: Array<{ title: string; url: string }>
}

export type ToolProgressData =
  | BashProgress
  | AgentToolProgress
  | MCPProgress
  | REPLToolProgress
  | SkillToolProgress
  | TaskOutputProgress
  | WebSearchProgress
  | Record<string, unknown>
