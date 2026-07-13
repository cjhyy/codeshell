export const DESKTOP_CONTROL_PROTOCOL_VERSION = 1;

export interface DesktopControlDescriptor {
  version: typeof DESKTOP_CONTROL_PROTOCOL_VERSION;
  pid: number;
  baseUrl: string;
  token: string;
  startedAt: number;
}

export interface MobileRemoteOpenResult {
  url: string;
  pairingUrl: string;
  expiresAt: number;
  mode: "tunnel" | "lan";
}

export interface MobileRemoteStatus {
  running: boolean;
  url?: string;
  mode?: "tunnel" | "lan";
  tunnelRunning: boolean;
  tunnelConnected: boolean;
  passcodeSet: boolean;
  onlineDeviceCount: number;
}

export type PetChatAttachmentKind = "image" | "file" | "audio" | "video";

/** Bytes already fetched by the gateway and ready for loopback transfer to desktop main. */
export interface PetChatInputAttachment {
  id: string;
  kind: PetChatAttachmentKind;
  name?: string;
  mimeType?: string;
  size: number;
  dataBase64: string;
}

export interface PetChatRequest {
  message: string;
  attachments?: PetChatInputAttachment[];
  origin?: {
    channel: string;
    target: string;
    senderId: string;
    messageId?: string;
  };
}

export interface PetChatResult {
  text: string;
  petSessionId: string;
  reason?: string;
}
