import {
  apiUrl,
  apiWorkspaceHeaders,
  captureApiScope,
  isControlPlaneUrl,
  isProjectUrl,
  type ApiScope,
} from "./api-context.js";

/** Same-origin, cookie-authenticated API. Hub account credentials never enter storage. */
export interface AuthSession {
  id: string;
  username: string;
  deviceName: string;
}

export interface AuthStatus {
  host?: "hub" | "desktop";
  mode?: "cloud-account";
  initialized: boolean;
  authenticated: boolean;
  session?: AuthSession;
  cloudSession?: CloudManagementSession;
}

/** Public scoped identity only; it is never a Hub login or a bearer credential. */
export interface CloudManagementSession {
  id: string;
  kind: "cloud-management";
  audience: string;
  installationId: string;
  accountOrigin: string;
  accountId: string;
  managementEpoch: string;
  expiresAt: number;
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
    readonly code?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export class InvalidAuthStatusError extends Error {
  constructor() {
    super("服务端返回了无效的登录状态，请稍后重试。");
  }
}

export async function api<T>(path: string, init: RequestInit = {}, scope?: ApiScope): Promise<T> {
  const workspaceHeaders = scope ? apiWorkspaceHeaders(scope.workspace) : apiWorkspaceHeaders();
  const request = { ...init };
  if (
    Object.keys(workspaceHeaders).length &&
    !isControlPlaneUrl(path) &&
    !isProjectUrl(path) &&
    !path.includes("workspace=")
  ) {
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(workspaceHeaders)) {
      if (!headers.has(name)) headers.set(name, value);
    }
    request.headers = headers;
  }
  const response = await fetch(
    scope ? apiUrl(path, scope.workspace, scope.projectId) : apiUrl(path, ""),
    {
      ...request,
      credentials: "same-origin",
      cache: "no-store",
    },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = typeof body.error === "string" ? body.error : body.error?.message;
    throw new ApiError(
      error ?? body.message ?? `请求失败（${response.status}）`,
      response.status,
      typeof body.code === "string" ? body.code : undefined,
      typeof body.retryAfterMs === "number" ? body.retryAfterMs : undefined,
    );
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
    const status = await api<Record<string, unknown>>("/api/v1/auth/status");
    const invalid = () => new InvalidAuthStatusError();
    if (
      !status ||
      typeof status.initialized !== "boolean" ||
      typeof status.authenticated !== "boolean" ||
      (status.mode !== undefined && status.mode !== "cloud-account")
    )
      throw invalid();
    if (status.mode === "cloud-account") {
      if (!status.initialized || (!status.authenticated && status.session !== undefined))
        throw invalid();
      let cloudSession: CloudManagementSession | undefined;
      if (status.authenticated) {
        const value = status.session as Record<string, unknown> | undefined;
        const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
        const origin = (value: unknown) => {
          if (typeof value !== "string") return false;
          try {
            const url = new URL(value);
            return (
              url.origin === value &&
              !url.username &&
              !url.password &&
              (url.protocol === "https:" ||
                (url.protocol === "http:" &&
                  ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
            );
          } catch {
            return false;
          }
        };
        if (
          !value ||
          Array.isArray(value) ||
          value.kind !== "cloud-management" ||
          ![value.id, value.installationId, value.accountId, value.managementEpoch].every(
            (id) => typeof id === "string" && uuid.test(id),
          ) ||
          !origin(value.audience) ||
          !origin(value.accountOrigin) ||
          (typeof window !== "undefined" && value.audience !== window.location.origin) ||
          !Number.isSafeInteger(value.expiresAt) ||
          (value.expiresAt as number) <= Date.now()
        )
          throw invalid();
        cloudSession = {
          id: value.id as string,
          kind: "cloud-management",
          audience: value.audience as string,
          installationId: value.installationId as string,
          accountOrigin: value.accountOrigin as string,
          accountId: value.accountId as string,
          managementEpoch: value.managementEpoch as string,
          expiresAt: value.expiresAt as number,
        };
      }
      return {
        initialized: true,
        authenticated: status.authenticated,
        mode: "cloud-account",
        ...(cloudSession ? { cloudSession } : {}),
      };
    }
    return {
      initialized: status.initialized,
      authenticated: status.authenticated,
      ...(status.host === "hub" || status.host === "desktop" ? { host: status.host } : {}),
      ...(status.session ? { session: status.session as AuthSession } : {}),
    };
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

export async function uploadFile(
  file: File,
  options: { signal?: AbortSignal; scope?: ApiScope } = {},
): Promise<UploadedFile> {
  const scope = options.scope ?? captureApiScope();
  return api(apiUrl(`/api/v1/uploads/${browserId()}`, scope.workspace, scope.projectId), {
    method: "PUT",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name),
    },
    body: file,
    signal: options.signal,
  });
}
