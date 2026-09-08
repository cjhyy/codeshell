import { apiWorkspaceHeaders } from "./api-context.js";

/** Same-origin, cookie-authenticated API. Hub account credentials never enter storage. */
export interface AuthSession {
  id: string;
  username: string;
  deviceName: string;
}

export interface AuthStatus {
  host?: "hub" | "desktop";
  initialized: boolean;
  authenticated: boolean;
  session?: AuthSession;
}

export interface DeviceSession {
  id: string;
  deviceName: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  current: boolean;
}

export interface UploadedFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  path: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const workspaceHeaders = apiWorkspaceHeaders();
  const request = { ...init };
  if (Object.keys(workspaceHeaders).length && !path.includes("workspace=")) {
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(workspaceHeaders)) {
      if (!headers.has(name)) headers.set(name, value);
    }
    request.headers = headers;
  }
  const response = await fetch(path, { ...request, credentials: "same-origin", cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = typeof body.error === "string" ? body.error : body.error?.message;
    throw new ApiError(error ?? body.message ?? `请求失败（${response.status}）`, response.status);
  }
  return body as T;
}

/** Called only after the existing paired WebSocket has authenticated this device. */
export async function ensureDesktopHttpSession(credentials: {
  deviceId: string;
  secretHash: string;
}): Promise<AuthSession> {
  const result = await post<{ authenticated: boolean; session?: AuthSession }>(
    "/api/v1/desktop/session",
    credentials,
  );
  if (!result.authenticated || !result.session)
    throw new ApiError("桌面连接已失效，请重新配对。", 401);
  return result.session;
}

export function post<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A 404 explicitly identifies the legacy passcode-only host. Other failures stay gated. */
export async function readAuthStatus(): Promise<AuthStatus | null> {
  try {
    const status = await api<AuthStatus>("/api/v1/auth/status");
    if (typeof status.initialized !== "boolean" || typeof status.authenticated !== "boolean") {
      throw new Error("服务端返回了无效的登录状态，请稍后重试。");
    }
    return status;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** Call once before React mounts, including StrictMode's double render. */
export function takeSetupToken(
  location: Pick<Location, "hash" | "pathname" | "search">,
  history: Pick<History, "replaceState" | "state">,
): string {
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
  const token = fragment.get("setup") ?? "";
  if (fragment.has("setup")) {
    fragment.delete("setup");
    const remaining = fragment.toString();
    history.replaceState(
      history.state,
      "",
      `${location.pathname}${location.search}${remaining ? `#${remaining}` : ""}`,
    );
  }
  return token;
}

/** getRandomValues is also available on plain HTTP private-network deployments. */
export function browserId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function uploadFile(file: File): Promise<UploadedFile> {
  return api(`/api/v1/uploads/${browserId()}`, {
    method: "PUT",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name),
    },
    body: file,
  });
}
