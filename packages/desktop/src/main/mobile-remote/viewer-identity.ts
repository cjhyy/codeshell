export interface MobileViewerIdentity {
  deviceId: string;
  viewerId: string;
}

export function mobileTranscriptSubscriberId(viewerId: string): string {
  if (!viewerId) throw new Error("authenticated mobile viewer id required");
  return `mobile:${viewerId}`;
}
