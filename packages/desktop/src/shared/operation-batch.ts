/** User-authored proposal only. Native confirmation and live custody are held in Main. */
export interface OperationBatchItem {
  owner: string;
  repo: string;
  title: string;
  body?: string;
}
export interface OperationBatchInput {
  sessionId: string;
  connectionId: string;
  items: OperationBatchItem[];
}
export interface OperationBatchOptions {
  connections: { id: string; label: string }[];
}
export type OperationBatchResult = { status: "cancelled" } | { status: "started"; count: number };
