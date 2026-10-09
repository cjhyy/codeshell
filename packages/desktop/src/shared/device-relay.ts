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
  onStatus(callback: (status: DesktopRelayStatus) => void): () => void;
}
