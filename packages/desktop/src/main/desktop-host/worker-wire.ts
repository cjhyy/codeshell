import type {
  WorkerBridgeCore,
  WorkerExitInfo,
  WorkerRequestOptions,
  WorkerRpcOutcome,
} from "@cjhyy/code-shell-server/worker";

// This port is transferred only between Main and its utility. The renderer
// never receives its peer or gains access to these launch and response frames.
export type DesktopWorkerDriver = Pick<
  WorkerBridgeCore,
  | "ensureWorker"
  | "hasChild"
  | "hasLiveWorker"
  | "canSend"
  | "workerGeneration"
  | "request"
  | "subscribeLines"
  | "sendLine"
  | "injectWorkerMessage"
  | "kill"
>;

export type WorkerCommand =
  | { type: "start"; generation: number; cwd: string; env: NodeJS.ProcessEnv }
  | { type: "write"; generation: number; line: string }
  | {
      type: "request";
      generation: number;
      call: number;
      method: string;
      params?: unknown;
      options: WorkerRequestOptions;
    }
  | { type: "stop"; generation: number };

export type WorkerNotice =
  | { type: "started"; generation: number; pid?: number }
  | { type: "spawn-failed"; generation: number; message?: string }
  | { type: "exit"; generation: number; info: WorkerExitInfo }
  | { type: "line"; generation: number; line: string }
  | { type: "result"; call: number; outcome: WorkerRpcOutcome }
  | { type: "stderr"; generation: number; text: string };

export interface WorkerPort {
  postMessage(message: WorkerCommand | WorkerNotice): void;
  on(
    event: "message",
    listener: (event: { data: unknown; ports: { close(): void }[] }) => void,
  ): unknown;
  on(event: "close", listener: () => void): unknown;
  start(): void;
  close(): void;
}
