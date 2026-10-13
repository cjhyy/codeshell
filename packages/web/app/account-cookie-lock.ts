/** Cookies are shared by tabs. Order their single-use refresh/Set-Cookie operations across the origin. */
export async function withAccountCookieLock<T>(operation: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (!locks?.request)
    throw new Error("浏览器不支持安全的登录会话管理，请使用新版 Chrome、Edge、Firefox 或 Safari。");
  return await locks.request("codeshell:account-web:cookie-v1", { mode: "exclusive" }, operation);
}
