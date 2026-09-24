import { createHash } from "node:crypto";

/** A saved cloud entry is an origin, never a setup/login URL or a local path. */
export function normalizeCloudWorkbenchAddress(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) throw new Error("请输入云端工作台地址。");
  const address = value.trim();
  if (!address || /[\x00-\x20\\]/.test(address)) throw new Error("云端地址格式无效。");
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error("请输入完整的 HTTPS 地址。");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("请填写工作台首页地址，不要包含初始化链接、登录令牌或项目路径。");
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw new Error("云端工作台需要 HTTPS；本机测试可以使用回环 HTTP 地址。");
  return `${url.origin}/`;
}

export function cloudWorkbenchPartition(address: string): string {
  return `persist:codeshell-cloud-${createHash("sha256").update(new URL(address).origin).digest("hex")}`;
}

export function isCloudWorkbenchOrigin(address: string, target: string): boolean {
  try {
    const url = new URL(target);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.origin === new URL(address).origin
    );
  } catch {
    return false;
  }
}

/** A cloud page may start one bounded Link flow. Link pages never acquire Desktop privileges. */
export function createCloudWorkbenchNavigation(address: string, now = Date.now) {
  const origin = new URL(address).origin;
  let flow: { issuer: string; state: string; expiresAt: number } | undefined;
  const reset = () => {
    flow = undefined;
  };
  return {
    reset,
    committed(target: string) {
      if (isCloudWorkbenchOrigin(address, target)) reset();
    },
    allows(current: string, target: string, mainFrame = true): boolean {
      if (flow && flow.expiresAt <= now()) reset();
      try {
        const url = new URL(target);
        if (url.username || url.password) return false;
        if (isCloudWorkbenchOrigin(address, target)) {
          if (mainFrame && flow && url.pathname === "/link/callback")
            return (
              !url.hash &&
              url.searchParams.getAll("state").length === 1 &&
              url.searchParams.get("state") === flow.state
            );
          return true;
        }
        if (!mainFrame) return false;
        if (flow) return url.origin === flow.issuer;
        if (!isCloudWorkbenchOrigin(address, current)) return false;
        if (
          url.protocol !== "https:" &&
          !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        )
          return false;
        const params = url.searchParams;
        const single = (key: string) => params.getAll(key).length === 1;
        if (
          url.pathname !== "/oauth/authorize" ||
          url.hash ||
          ![
            "response_type",
            "client_id",
            "redirect_uri",
            "state",
            "code_challenge",
            "code_challenge_method",
          ].every(single) ||
          params.get("response_type") !== "code" ||
          !params.get("client_id") ||
          params.get("redirect_uri") !== `${origin}/link/callback` ||
          params.get("code_challenge_method") !== "S256" ||
          !/^[A-Za-z0-9_-]{43}$/.test(params.get("code_challenge") ?? "") ||
          !/^[A-Za-z0-9_-]{32,128}$/.test(params.get("state") ?? "")
        )
          return false;
        flow = { issuer: url.origin, state: params.get("state")!, expiresAt: now() + 600_000 };
        return true;
      } catch {
        return false;
      }
    },
  };
}
