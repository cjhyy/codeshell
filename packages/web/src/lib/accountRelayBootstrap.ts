export interface AccountRelayBootstrapCredential {
  deviceId: string;
  secretHash: string;
  expiresAt: number;
  accountEntryUrl?: string;
}

export type AccountRelayBootstrapResult =
  | { kind: "ready"; credential: AccountRelayBootstrapCredential }
  | { kind: "legacy" }
  | { kind: "expired"; accountEntryUrl?: string }
  | { kind: "retry" };

/**
 * The SPA and the Host's pre-SPA recovery page use this same browser function.
 * Keep it self-contained: the Host embeds its compiled source under a nonce CSP.
 * Only cookie bootstrap requests belong here; never replay an application action.
 */
export async function accountRelayBootstrap(
  signal: AbortSignal,
  renew = false,
  expectedAccount = false,
): Promise<AccountRelayBootstrapResult> {
  const maximumAge = 10 * 60_000;
  const clockSkew = 30_000;
  let entry: string | undefined;
  const request = async (path: string, body?: object) => {
    signal.throwIfAborted();
    const response = await fetch(path, {
      ...(body
        ? {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    const value = response.headers.get("content-type")?.includes("application/json")
      ? await response.json()
      : undefined;
    signal.throwIfAborted();
    try {
      const url = new URL(value?.accountEntryUrl);
      if (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        url.pathname === "/app" &&
        !url.search &&
        !url.hash
      )
        entry = url.href;
    } catch {
      /* Untrusted navigation is never followed. */
    }
    return { response, value };
  };
  const credential = (value: Record<string, unknown> | undefined, activeRequired = true) => {
    const now = Date.now();
    if (
      !value ||
      (activeRequired && value.active !== true) ||
      typeof value.deviceId !== "string" ||
      !value.deviceId ||
      value.deviceId.length > 512 ||
      typeof value.secretHash !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.secretHash) ||
      !Number.isSafeInteger(value.expiresAt) ||
      (value.expiresAt as number) <= now ||
      (value.expiresAt as number) > now + maximumAge + clockSkew
    )
      return undefined;
    return {
      deviceId: value.deviceId,
      secretHash: value.secretHash,
      expiresAt: Math.min(value.expiresAt as number, now + maximumAge),
      accountEntryUrl: entry,
    };
  };
  if (!renew) {
    const { response, value } = await request("/api/v1/relay/session");
    const ended =
      (response.status === 401 && value?.error === "invalid_relay_authorization") ||
      (value?.accountRelay === true && value.active !== true);
    if (!ended) {
      if (response.ok && value?.active === true) {
        const ready = credential(value);
        return ready
          ? { kind: "ready", credential: ready }
          : { kind: "expired", accountEntryUrl: entry };
      }
      // A gateway's offline response must not fall back to durable LAN pairing.
      if (expectedAccount || response.status >= 500) return { kind: "retry" };
      return { kind: "legacy" };
    }
  }
  const resumed = await request("/__relay/session/resume", {});
  if (resumed.response.status === 401 && resumed.value?.error === "invalid_relay_authorization")
    return { kind: "expired", accountEntryUrl: entry };
  if (resumed.response.status === 404) return { kind: "expired", accountEntryUrl: entry }; // Older gateway: keep its explicit revalidation path.
  const now = Date.now();
  if (
    !resumed.response.ok ||
    typeof resumed.value?.handoff !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(resumed.value.handoff) ||
    !Number.isSafeInteger(resumed.value.expiresAt) ||
    resumed.value.expiresAt <= now ||
    resumed.value.expiresAt > now + maximumAge + clockSkew
  )
    return { kind: "retry" };
  const exchanged = await request("/api/v1/relay/session", { handoff: resumed.value.handoff });
  if (exchanged.response.status === 401 && exchanged.value?.error === "invalid_relay_authorization")
    return { kind: "expired", accountEntryUrl: entry };
  if (exchanged.response.status === 401 && exchanged.value?.accountRelay === true)
    return { kind: "expired", accountEntryUrl: entry };
  const ready = exchanged.response.ok ? credential(exchanged.value, false) : undefined;
  if (!ready) return { kind: "retry" };
  // Confirm that this browser accepted the short HttpOnly cookie before the
  // pre-SPA page reloads. A blocked cookie must not produce a navigation loop.
  const restored = await request("/api/v1/relay/session");
  if (restored.response.status === 401 && restored.value?.error === "invalid_relay_authorization")
    return { kind: "expired", accountEntryUrl: entry };
  const accepted = restored.response.ok ? credential(restored.value) : undefined;
  return accepted
    ? {
        kind: "ready",
        credential: {
          ...accepted,
          expiresAt: Math.min(accepted.expiresAt, resumed.value.expiresAt),
        },
      }
    : { kind: "retry" };
}

/**
 * The Host's pre-SPA page for an ended or expiring account relay grant. It runs
 * the same cookie-only bootstrap as the SPA under a per-response nonce CSP and
 * reloads once a fresh grant is accepted.
 */
export function accountRelayRecoveryPage(accountEntryUrl: string): {
  policy: string;
  html: string;
} {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  const nonce = btoa(String.fromCharCode(...bytes));
  const escape = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (character) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
    );
  const script = `
    const bootstrap = (${accountRelayBootstrap.toString()});
    let stopped = false, active, timer, failures = 0;
    const title = document.querySelector('h1');
    const detail = document.querySelector('p');
    function later() {
      if (stopped || document.hidden) return;
      clearTimeout(timer);
      timer = setTimeout(connect, Math.min(8000, 800 * 2 ** Math.min(failures++, 4)));
    }
    async function connect() {
      if (stopped || document.hidden || active) return;
      clearTimeout(timer);
      const attempt = new AbortController(); active = attempt;
      try {
        const result = await bootstrap(attempt.signal, true, true);
        if (stopped || active !== attempt || attempt.signal.aborted) return;
        if (result.kind === 'ready') { stopped = true; location.reload(); return; }
        if (result.kind === 'expired') {
          stopped = true;
          title.textContent = '远程连接授权已结束';
          detail.textContent = '返回电脑列表，用 Passkey 确认后重新连接这台电脑。';
          return;
        }
        detail.textContent = '电脑暂时离线，正在自动恢复连接。';
        later();
      } catch {
        if (!stopped && !attempt.signal.aborted) later();
      } finally {
        if (active === attempt) active = undefined;
        if (attempt.signal.aborted && !stopped && !document.hidden) later();
      }
    }
    addEventListener('pagehide', () => { stopped = true; active?.abort(); clearTimeout(timer); });
    addEventListener('online', connect);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { active?.abort(); clearTimeout(timer); }
      else connect();
    });
    connect();
  `;
  return {
    policy: `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    html: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>恢复电脑连接 · CodeShell</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:24px}h1{font-size:24px}a{display:inline-block;padding:10px 16px;border-radius:8px;background:#2563eb;color:white;text-decoration:none}</style><main><h1>正在恢复电脑连接</h1><p>正在恢复已验证的连接，无需重复操作。</p><a href="${escape(accountEntryUrl)}" rel="noreferrer">返回电脑列表</a><noscript>请启用 JavaScript，或返回电脑列表重新连接。</noscript></main><script nonce="${nonce}">${script}</script></html>`,
  };
}
