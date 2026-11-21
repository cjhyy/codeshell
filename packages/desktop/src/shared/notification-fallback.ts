export interface NotificationFallback {
  message: string;
  detail?: string;
  sessionId?: string;
}

export const fallbackReady = "notification:fallback-ready";
export const fallbackNotice = "notification:fallback";
