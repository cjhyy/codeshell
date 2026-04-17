import type { StdoutMessage } from '../../entrypoints/sdk/controlTypes.js'

/**
 * Transport 接口 — 远程会话的双向通信抽象
 *
 * 定义了读（接收事件）和写（发送事件）两个方向的能力，
 * 具体实现有 WebSocket / SSE / Hybrid 三种。
 */
export interface Transport {
  /** 建立连接 */
  connect(): Promise<void>

  /** 发送单条消息 */
  write(message: StdoutMessage): Promise<void>

  /** 批量发送消息 */
  writeBatch?(messages: StdoutMessage[]): Promise<void>

  /** 关闭连接并释放资源 */
  close(): void

  /** 当前是否已连接 */
  isConnectedStatus(): boolean

  /** 当前是否已关闭 */
  isClosedStatus(): boolean

  /** 返回当前状态标签（idle / connected / reconnecting / closed） */
  getStateLabel(): string

  /** 注册数据回调（下行消息） */
  setOnData(callback: (data: string) => void): void

  /** 注册连接建立回调 */
  setOnConnect(callback: () => void): void

  /** 注册连接关闭回调 */
  setOnClose(callback: (closeCode?: number) => void): void

  /** SSE 序列号高水位（WebSocket 实现返回 0） */
  getLastSequenceNum?(): number

  /** 被丢弃的批次计数 */
  droppedBatchCount?: number
}
