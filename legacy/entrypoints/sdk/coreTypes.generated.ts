/**
 * Generated SDK core types — stub.
 * In production, these are generated from Zod schemas via generate-sdk-types.ts.
 */

export type SDKMessage = SDKUserMessage | SDKAssistantMessage | SDKResultMessage | SDKProgressMessage

export type SDKUserMessage = {
  type: 'user'
  content: string | unknown[]
}

export type SDKAssistantMessage = {
  type: 'assistant'
  content: string | unknown[]
  model?: string
}

export type SDKResultMessage = {
  type: 'result'
  result: string
  subtype: 'success' | 'error' | 'error_max_turns' | 'interrupted'
  cost_usd?: number
  duration_ms?: number
  duration_api_ms?: number
  is_error: boolean
  num_turns: number
  session_id: string
  total_cost_usd?: number
}

export type SDKProgressMessage = {
  type: 'progress'
  content: unknown
}

export type SDKSessionInfo = {
  id: string
  sessionId: string
  type: 'session'
  dir: string
  model: string
  title?: string
  summary?: string
  tag?: string
  starterPrompt?: string
  createdAt: string
  updatedAt: string
  messageCount: number
  hasUnreadMessages?: boolean
  costUsd?: number
}
