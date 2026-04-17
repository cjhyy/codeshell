/**
 * SDK control protocol types — stub for bridge subpath consumers.
 */

export type SDKControlRequest = {
  type: string
  requestId?: string
  payload?: unknown
}

export type SDKControlResponse = {
  type: string
  requestId?: string
  payload?: unknown
  error?: string
}
