import { isEnvironmentDescriptor, type EnvironmentDescriptor } from "../src/lib/environment.js";

export interface SavedEnvironment {
  address: string;
  name: string;
  environmentId?: string;
}

const KEY = "codeshell.environments.v1";
const LIMIT = 32;
type StorageAccess = Pick<Storage, "getItem" | "setItem">;

/** Navigation only: never forwards this host's cookies or credentials to another origin. */
export function environmentAddress(value: string): string {
  if (value.length > 2048 || /[\\\u0000-\u0020\u007f]/.test(value))
    throw new Error("请输入完整的工作台地址。");
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("请使用不含密码、配对令牌或查询参数的工作台地址。");
  if (!["/", "/mobile", "/mobile/"].includes(url.pathname))
    throw new Error("请填写工作台首页或桌面 /mobile 地址。");
  return url.origin + (url.pathname.startsWith("/mobile") ? "/mobile" : "/");
}

function savedEnvironment(value: unknown): SavedEnvironment {
  if (!value || typeof value !== "object") throw new Error("无效的连接记录。");
  const item = value as SavedEnvironment;
  if (
    typeof item.address !== "string" ||
    typeof item.name !== "string" ||
    !item.name.trim() ||
    item.name.length > 80 ||
    /[\u0000-\u001f\u007f]/.test(item.name)
  )
    throw new Error("连接名称需为 1–80 个字符。");
  if (
    item.environmentId !== undefined &&
    !isEnvironmentDescriptor({
      version: 1,
      id: item.environmentId,
      name: "Host",
      kind: "hub",
      entryPath: "/",
    })
  )
    throw new Error("无效的环境身份。");
  return {
    address: environmentAddress(item.address),
    name: item.name.trim(),
    ...(item.environmentId ? { environmentId: item.environmentId } : {}),
  };
}

export function readEnvironments(storage: StorageAccess): SavedEnvironment[] {
  const raw = storage.getItem(KEY);
  if (raw === null) return [];
  if (raw.length > 100_000) throw new Error("连接记录过大，请清理当前工作台的连接记录。");
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.length > LIMIT) throw new Error("连接记录格式无效。");
  return value.map(savedEnvironment);
}

export function saveEnvironment(
  storage: StorageAccess,
  input: SavedEnvironment,
): SavedEnvironment[] {
  const item = savedEnvironment(input);
  const current = readEnvironments(storage);
  const existing = current.find((entry) => entry.address === item.address);
  if (
    existing?.environmentId &&
    item.environmentId &&
    existing.environmentId !== item.environmentId
  )
    throw new Error("这个地址的环境身份已变化。请确认目标后，删除旧连接再添加。");
  const next = [
    ...current.filter((entry) => entry.address !== item.address),
    {
      ...item,
      ...(existing?.environmentId ? { environmentId: existing.environmentId } : {}),
    },
  ];
  if (next.length > LIMIT) throw new Error("最多保存 32 个环境，请先移除不再使用的连接。");
  storage.setItem(KEY, JSON.stringify(next));
  return next;
}

export function removeEnvironment(storage: StorageAccess, address: string): SavedEnvironment[] {
  const next = readEnvironments(storage).filter(
    (item) => item.address !== environmentAddress(address),
  );
  storage.setItem(KEY, JSON.stringify(next));
  return next;
}

export function verifyCurrentEnvironment(
  saved: readonly SavedEnvironment[],
  origin: string,
  environment: EnvironmentDescriptor,
): void {
  const item = saved.find((entry) => entry.address === origin + environment.entryPath);
  if (item?.environmentId && item.environmentId !== environment.id)
    throw new Error("当前地址对应的环境已变化，请核对项目后重新保存连接。");
}
