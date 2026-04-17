/**
 * SDK tool types — stub for tool type re-exports.
 */

/** @internal */
export type ToolName = string

/** @internal */
export type ToolInput = Record<string, unknown>

/** @internal */
export type ToolResult = {
  type: 'tool_result'
  tool_use_id: string
  content: string | unknown[]
  is_error?: boolean
}
