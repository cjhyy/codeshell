import { randomBytes } from "node:crypto";
import { accountRelayBootstrap } from "@cjhyy/code-shell-web/account-relay-bootstrap";

export function accountRelayRecoveryPage(accountEntryUrl: string) {
  const nonce = randomBytes(18).toString("base64");
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
