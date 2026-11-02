/** Public desktop state deliberately excludes the computer credential and enrollment ticket. */
export type DesktopRelayState =
  | "unregistered"
  | "stopped"
  | "connecting"
  | "ready"
  | "disconnected"
  | "unauthorized"
  | "storage-error";
export interface DesktopRelayStatus {
  state: DesktopRelayState;
  registered: boolean;
  relayOrigin?: string;
  publicOrigin?: string;
  hostId?: string;
  name?: string;
  accountId?: string;
  /** Reconnect the saved registration when Desktop starts. */
  autoConnect: boolean;
  /** Default computer name offered before registration. */
  suggestedName: string;
}
export interface DesktopRelayEnrollment {
  relayOrigin: string;
  ticket?: string;
  /** Explicit account authorization; omitting this preserves legacy ticket enrollment. */
  authorization?: "account";
  name: string;
}
export interface DesktopRelayApi {
  status(): Promise<DesktopRelayStatus>;
  enroll(input: DesktopRelayEnrollment): Promise<DesktopRelayStatus>;
  forget(): Promise<void>;
  setAutoConnect(enabled: boolean): Promise<DesktopRelayStatus>;
  onStatus(callback: (status: DesktopRelayStatus) => void): () => void;
}
