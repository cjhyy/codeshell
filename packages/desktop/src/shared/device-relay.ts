import type { AccountFeatureView } from "./account-features.js";

/** Public desktop state deliberately excludes the computer credential and enrollment ticket. */
export type DesktopRelayState =
  | "unregistered"
  | "stopped"
  | "connecting"
  | "ready"
  | "disconnected"
  | "unauthorized"
  | "storage-error"
  | "unavailable";
export interface DesktopRelayStatus {
  state: DesktopRelayState;
  registered: boolean;
  relayOrigin?: string;
  publicOrigin?: string;
  hostId?: string;
  name?: string;
  accountId?: string;
  environmentId?: string;
  message?: string;
}
/**
 * An account-registered computer opens from the account's computer list (the
 * phone entry). Only while the account's `relay.phone` feature is ready; the
 * URL is the public directory page and carries no credential.
 */
export function accountComputerListUrl(
  status: DesktopRelayStatus,
  phone: Pick<AccountFeatureView, "state" | "params">,
): string | undefined {
  return phone.state === "ready" && status.relayOrigin
    ? `${status.relayOrigin.replace(/\/$/, "")}${phone.params?.directoryPath ?? "/"}`
    : undefined;
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
