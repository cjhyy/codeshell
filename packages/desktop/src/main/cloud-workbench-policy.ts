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
