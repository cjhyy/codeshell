import type { ChannelCapabilities } from "./channel.js";

export const DESKTOP_CONTROL_PROTOCOL_VERSION = 1;

export interface DesktopControlDescriptor {
  version: typeof DESKTOP_CONTROL_PROTOCOL_VERSION;
  pid: number;
  baseUrl: string;
  token: string;
  startedAt: number;
}

export interface DesktopControlEvent {
  id: number;
  createdAt: number;
  type:
    | "tunnel.connected"
    | "tunnel.disconnected"
    | "tunnel.error"
    | "pet.task.completed"
    | "pet.task.failed"
    | "pet.task.cancelled"
    | "pet.task.reported";
  text: string;
  title?: string;
  button?: { text: string; url: string };
  attachments?: DesktopControlEventAttachment[];
  /** One originating IM conversation; bypasses general notification targets. */
  target?: { channel: string; target: string };
}

export interface DesktopControlEventAttachment {
  kind: PetChatAttachmentKind;
  name: string;
  mimeType: string;
  size: number;
  /** Validated local path on the same host as the loopback gateway. */
  path: string;
}

export interface DesktopControlEventPage {
  /** Changes whenever the Desktop loopback control server restarts. */
  streamId: string;
  events: DesktopControlEvent[];
  cursor: number;
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
    /** Adapter-declared implementation capabilities for this exact route. */
    capabilities: ChannelCapabilities;
    /** Enabled adapters in this Gateway process, without credentials or target ids. */
    channels?: PetChatGatewayChannel[];
  };
}

export interface PetChatGatewayChannel {
  channel: string;
  capabilities: ChannelCapabilities;
}

export interface PetChatResult {
  text: string;
  petSessionId: string;
  reason?: string;
  /** GatewayReply URL action; rendered natively or as a labelled link by the adapter. */
  button?: { text: string; url: string };
  /** Host-produced reply attachments; same host-local path shape as event attachments. */
  attachments?: DesktopControlEventAttachment[];
}
