/**
 * SDK runtime types — non-serializable types (callbacks, interfaces with methods).
 * Stub file to satisfy imports from agentSdkTypes.ts.
 */
import type { z } from 'zod'
import type {
  SDKMessage,
  SDKResultMessage,
  SDKSessionInfo,
  SDKUserMessage,
} from './coreTypes.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyZodRawShape = Record<string, z.ZodTypeAny>

export type InferShape<T extends AnyZodRawShape> = {
  [K in keyof T]: z.infer<T[K]>
}

export type SdkMcpToolDefinition<Schema extends AnyZodRawShape = AnyZodRawShape> = {
  name: string
  description: string
  inputSchema: Schema
  handler: (args: InferShape<Schema>, extra: unknown) => Promise<unknown>
  annotations?: Record<string, unknown>
  searchHint?: string
  alwaysLoad?: boolean
}

export type McpSdkServerConfigWithInstance = {
  name: string
  version?: string
  tools?: Array<SdkMcpToolDefinition>
}

export interface Options {
  model?: string
  maxTurns?: number
  systemPrompt?: string
  appendSystemPrompt?: string
  allowedTools?: string[]
  disallowedTools?: string[]
  mcpServers?: Record<string, unknown>
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
  abortController?: AbortController
  cwd?: string
  resume?: boolean
  maxTokens?: number
  continueConversation?: boolean
  customTools?: SdkMcpToolDefinition[]
  mcpToolFilter?: (tool: { name: string; serverName: string }) => boolean
  enableRemoteControl?: boolean
}

export interface InternalOptions extends Options {
  /** @internal */
  dangerouslySkipPermissions?: boolean
}

export interface Query extends AsyncIterable<SDKMessage> {
  result: Promise<SDKResultMessage>
  abort(): void
  messages: SDKMessage[]
}

export type InternalQuery = Query

export interface SDKSessionOptions {
  model?: string
  cwd?: string
  systemPrompt?: string
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
}

export interface SDKSession {
  readonly sessionId: string
  send(message: string | SDKUserMessage): Query
  close(): Promise<void>
}

export interface SessionMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | unknown[]
  timestamp?: number
}

export interface ListSessionsOptions {
  dir?: string
  limit?: number
  offset?: number
}

export interface GetSessionInfoOptions {
  dir?: string
}

export interface GetSessionMessagesOptions {
  dir?: string
  limit?: number
  offset?: number
  includeSystemMessages?: boolean
}

export interface SessionMutationOptions {
  dir?: string
}

export interface ForkSessionOptions {
  dir?: string
  upToMessageId?: string
  title?: string
}

export interface ForkSessionResult {
  sessionId: string
}
