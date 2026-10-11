import { afterEach, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import tls from "node:tls";

if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-bun-completion-")) throw Error("isolated HOME required");
const repo = process.cwd();
const { installLocalNetworkGuard } = await import(`${repo}/scripts/runtime-cost-smoke-isolation.mjs`);
installLocalNetworkGuard("http://127.0.0.1:9");
let unexpectedNetwork = 0;
const deny = () => { unexpectedNetwork++; throw Error("NETWORK_FORBIDDEN_round16"); };
net.connect = net.createConnection = deny as any;
tls.connect = deny as any;
const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import(`${repo}/packages/desktop/node_modules/react-dom/client`);
const { ensureMiniDom, flushMicrotasks } = await import(`${repo}/packages/desktop/src/renderer/test-utils/renderHook.tsx`);
const webController = await import(`${repo}/packages/web/src/link-authorization.ts`);
const webView = await import(`${repo}/packages/web/src/link-authorization-view.tsx`);
const webExports = await import(`${repo}/packages/web/dist/index.js`);
mock.module("@cjhyy/code-shell-web", () => ({ ...webExports, ...webController, ...webView }));
const Passthrough = ({ children, ...props }: any) => <div {...props}>{children}</div>;
mock.module(`${repo}/packages/desktop/src/renderer/components/ui/dialog.tsx`, () => ({
  Dialog: ({ children }: any) => <div>{children}</div>, DialogContent: Passthrough,
  DialogDescription: Passthrough, DialogFooter: Passthrough, DialogHeader: Passthrough, DialogTitle: Passthrough,
}));
const { LinkConnectionDialog } = await import(`${repo}/packages/desktop/src/renderer/credentials/LinkConnectionDialog.tsx`);
const { CredentialStore, PlaintextCipher } = await import(`${repo}/packages/core/dist/index.js`);
const { createLinkService } = await import(`${repo}/packages/server/src/links/service.ts`);
const { createNativeLinkAuthorizationManager } = await import(`${repo}/packages/desktop/src/main/link-authorization-manager.ts`);
ensureMiniDom();
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const nodes = (n: any): any[] => [n, ...Array.from(n?.childNodes ?? []).flatMap(nodes)];
const props = (n: any): any => { const k = Object.keys(n ?? {}).find(k => k.startsWith("__reactProps$")); return k ? n[k] : {}; };
const textOf = (n: any): string => n?.nodeType === 3 ? n.nodeValue ?? "" : Array.from(n?.childNodes ?? []).map(textOf).join("") || n?.textContent || "";
const settle = async () => { await flushMicrotasks(); await new Promise(r => setTimeout(r, 0)); await flushMicrotasks(); };
const activeFixtures: any[] = [];
async function fixture(options: { deferBegin?: boolean; failBegin?: boolean; uncertainRespond?: boolean; deferValidation?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "codeshell-link-recovery-round16-"));
  const store = new CredentialStore(undefined, new PlaintextCipher(), join(directory, "shared-user"));
  const owned = new Set([join(directory, "a"), join(directory, "b")]);
  for (const cwd of owned) mkdirSync(cwd);
  const contexts = new Map<string, any>();
  const beginReply = deferred<any>(), validationReply = deferred<void>();
  const begins: any[] = [], cancels: any[] = [], responds: any[] = [], successes: any[] = [];
  let statusCalls = 0, validationCalls = 0, nativeWindows = 0, firstBegin = true, firstRespond = true;
  const target = (cwd: string) => {
    if (!owned.has(cwd)) throw Error("fixture cwd not owned");
    let value = contexts.get(cwd);
    if (!value) {
      const service = createLinkService({ cwd, store,
        validateToken: async (_provider: string, _token: string, opts: any) => {
          validationCalls++;
          if (options.deferValidation && validationCalls === 1) await validationReply.promise;
          return { providerId: "github", identity: { externalAccountId: "owned-account", label: "Owned fixture" }, capabilityIds: [], verifiedAt: new Date().toISOString() };
        },
      });
      const manager = createNativeLinkAuthorizationManager({ service, open: () => { nativeWindows++; throw Error("native windows forbidden"); } });
      value = { service, manager, context: { ownerId: "owned-window", authorize: () => owned.has(cwd) } };
      contexts.set(cwd, value);
    }
    return value;
  };
  const api = {
    authorizationStart: async (cwd: string, id: string, input: any, mode: string) => {
      begins.push({ cwd, id, input, mode });
      if (options.failBegin && firstBegin) { firstBegin = false; throw Error("owned begin transport failure"); }
      const t = target(cwd), job = await t.manager.start(t.context, id, input, mode);
      begins[begins.length - 1].job = job;
      if (options.deferBegin && begins.length === 1) { await beginReply.promise; }
      return job;
    },
    authorizationGet: async (cwd: string, id: string) => { statusCalls++; const t = target(cwd); return t.manager.get(t.context, id); },
    authorizationRespond: async (cwd: string, id: string, response: any) => {
      responds.push({ cwd, id, response }); const t = target(cwd);
      const result = await t.manager.respond(t.context, id, response);
      if (options.uncertainRespond && firstRespond) { firstRespond = false; throw Error("owned response lost after commit"); }
      return result;
    },
    authorizationCancel: async (cwd: string, id: string) => { cancels.push({ cwd, id }); const t = target(cwd); return t.manager.cancel(t.context, id); },
    authorizationOpen: () => { throw Error("browser open forbidden"); },
  };
  Object.defineProperty(window, "codeshell", { configurable: true, value: { links: api, openExternal: () => { throw Error("external forbidden"); } } });
  const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container);
  let mounted = true, closeCalls = 0;
  const draw = async (cwd: string, visible = true) => {
    await act(async () => { root.render(visible ? <LinkConnectionDialog key={cwd} cwd={cwd}
      input={{ providerId: "github", methodId: "fine-grained-pat", label: "Owned fixture", expectedRevision: null }}
      providerName="Owned GitHub fixture" icon={() => null}
      modes={[{ id: "token", methodId: "fine-grained-pat", kind: "credential-input", available: true, preferred: true, label: "Token" }] as any}
      onClose={() => { closeCalls++; root.render(null); }} onConnected={(c: any) => successes.push(c)} /> : null); await settle(); });
  };
  const until = async (check: () => boolean) => { const deadline = Date.now() + 7000; while (!check()) { if (Date.now() > deadline) throw Error("fixture wait: " + textOf(container)); await act(settle); } };
  const button = (label: string) => nodes(container).find(n => n.tagName === "BUTTON" && textOf(n).includes(label));
  const click = async (n: any) => { expect(n).toBeDefined(); await act(async () => { props(n).onClick(); await settle(); }); };
  const token = () => nodes(container).find(n => n.tagName === "INPUT" && props(n).name === "token");
  const type = async (value: string) => { expect(token()).toBeDefined(); await act(async () => { props(token()).onChange({ target: { value } }); await settle(); }); };
  const submit = async (twice = false) => { const form = nodes(container).find(n => n.tagName === "FORM"); expect(form).toBeDefined(); await act(async () => { props(form).onSubmit({ preventDefault() {} }); if (twice) props(form).onSubmit({ preventDefault() {} }); await settle(); }); };
  const f = { directory, store, contexts, target, begins, cancels, responds, successes, api, beginReply, validationReply,
    a: [...owned][0], b: [...owned][1], draw, until, button, click, token, type, submit,
    text: () => textOf(container), closeCalls: () => closeCalls, statusCalls: () => statusCalls, validationCalls: () => validationCalls, nativeWindows: () => nativeWindows,
    cleanup: async () => { if (mounted) { await act(async () => { root.unmount(); await settle(); }); mounted = false; } for (const t of contexts.values()) { t.manager.close(); t.service.close(); } container.parentNode?.removeChild(container); rmSync(directory, { recursive: true, force: true }); },
  };
  activeFixtures.push(f); await draw(f.a); return f;
}
afterEach(async () => { for (const f of activeFixtures.splice(0)) await f.cleanup(); expect(unexpectedNetwork).toBe(0); });

test("real dialog close during pending startup cancels request and late job, then a fresh dialog can connect", async () => {
  const f = await fixture({ deferBegin: true }); await f.until(() => Boolean(f.begins[0]?.job));
  expect(f.store.list()).toHaveLength(0); const old = f.begins[0];
  await f.click(f.button("取消")); expect(f.closeCalls()).toBe(1);
  expect(f.cancels.some((c: any) => c.id === old.id)).toBe(true);
  f.beginReply.resolve(undefined); await act(settle);
  expect((await f.target(f.a).manager.get(f.target(f.a).context, old.job.id)).state).toBe("cancelled");
  expect(f.successes).toHaveLength(0); expect(f.store.list()).toHaveLength(0);
  await f.draw(f.a); await f.until(() => Boolean(f.token())); expect(f.begins).toHaveLength(2); expect(f.begins[1].id).not.toBe(old.id);
  await f.type("owned-retry-token"); expect(f.store.list()).toHaveLength(0); await f.submit(); await f.until(() => f.successes.length === 1);
  expect(f.store.list()).toHaveLength(1); expect(f.store.resolve(f.successes[0].id)?.secret).toBe("owned-retry-token");
  expect(f.nativeWindows()).toBe(0);
});

test("real dialog reports a failed begin and explicit retry connects once without duplicate submit", async () => {
  const f = await fixture({ failBegin: true }); await f.until(() => f.text().includes("owned begin transport failure"));
  expect(f.store.list()).toHaveLength(0); expect(f.successes).toHaveLength(0);
  await f.click(f.button("重新授权")); await f.until(() => Boolean(f.token()));
  expect(f.begins).toHaveLength(2); await f.type("owned-explicit-token");
  const tokenNode = f.token(); expect(props(tokenNode).value).toBe("owned-explicit-token"); expect(f.validationCalls()).toBe(0);
  await f.submit(true); await f.until(() => f.successes.length === 1);
  expect(f.responds).toHaveLength(1); expect(f.validationCalls()).toBe(1); expect(f.store.list()).toHaveLength(1); expect(f.nativeWindows()).toBe(0);
});

test("lost response after real credential commit is reconciled by status without replaying secret", async () => {
  const f = await fixture({ uncertainRespond: true }); await f.until(() => Boolean(f.token()));
  await f.type("owned-once-token"); await f.submit(); await f.until(() => f.text().includes("owned response lost after commit"));
  expect(f.store.list()).toHaveLength(1); expect(f.successes).toHaveLength(0); expect(f.responds).toHaveLength(1); expect(props(f.token()).value).toBe("");
  await f.until(() => f.successes.length === 1);
  expect(f.statusCalls()).toBeGreaterThan(0); expect(f.responds).toHaveLength(1); expect(f.validationCalls()).toBe(1); expect(f.store.list()).toHaveLength(1);
  expect(f.store.resolve(f.successes[0].id)?.secret).toBe("owned-once-token"); expect(f.nativeWindows()).toBe(0);
});

test("formal cwd key remount retires pending validation and clears the old secret before new project authorization", async () => {
  const f = await fixture({ deferValidation: true }); await f.until(() => Boolean(f.token()));
  await f.type("owned-old-project-token"); await f.submit(); await f.until(() => f.validationCalls() === 1);
  const oldJob = f.begins[0].job;
  await f.draw(f.b); await f.until(() => Boolean(f.token()));
  expect(f.begins).toHaveLength(2); expect(f.begins[1].cwd).toBe(f.b); expect(props(f.token()).value).toBe("");
  f.validationReply.resolve(); await act(settle);
  expect(f.successes).toHaveLength(0); expect(f.store.list()).toHaveLength(0);
  expect((await f.target(f.a).manager.get(f.target(f.a).context, oldJob.id)).state).toBe("cancelled");
  await f.type("owned-new-project-token"); await f.submit(); await f.until(() => f.successes.length === 1);
  expect(f.store.list()).toHaveLength(1); expect(f.responds.map((r: any) => r.cwd)).toEqual([f.a, f.b]);
  expect(f.store.resolve(f.successes[0].id)?.secret).toBe("owned-new-project-token"); expect(f.nativeWindows()).toBe(0);
});

test("real native manager cancels delayed OAuth window dispatch, rejects another owner, and permits a fresh attempt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codeshell-link-dispatch-round16-"));
  const store = new CredentialStore(undefined, new PlaintextCipher(), join(directory, "owned-user"));
  const service = createLinkService({ store, remoteLink: () => ({ issuer: "https://owned-fixture.invalid", clientId: "owned-client", redirectUri: "http://127.0.0.1/owned-callback" }), readRemoteCatalog: async () => ["github"] });
  const dispatch = deferred<any>(); const opened: any[] = []; let closes = 0;
  const manager = createNativeLinkAuthorizationManager({ service, open: (input: any) => {
    opened.push(input); const handle = { close() { closes++; }, focus() {} };
    return opened.length === 1 ? dispatch.promise : handle;
  } });
  const context = { ownerId: "owned-window", authorize: () => true };
  const input = { providerId: "github", methodId: "remote-link", label: "Owned remote fixture", expectedRevision: null };
  try {
    const request = crypto.randomUUID(); const pending = manager.start(context, request, input, "remote-link");
    for (let i = 0; i < 100 && !opened.length; i++) await Promise.resolve();
    expect(opened).toHaveLength(1); expect(opened[0].signal.aborted).toBe(false);
    await expect(manager.cancel({ ...context, ownerId: "other-window" }, request)).rejects.toThrow("找不到");
    expect(opened[0].signal.aborted).toBe(false);
    await manager.cancel(context, request); expect(opened[0].signal.aborted).toBe(true);
    dispatch.resolve({ close() { closes++; }, focus() {} });
    expect((await pending).state).toBe("cancelled"); expect(closes).toBe(1); expect(store.list()).toHaveLength(0);
    expect(await opened[0].onCallback("http://127.0.0.1/owned-callback?code=late&state=late")).toBe(false);
    const fresh = await manager.start(context, crypto.randomUUID(), input, "remote-link");
    expect(fresh.state).toBe("pending"); expect(opened).toHaveLength(2); expect(opened[1].signal.aborted).toBe(false);
    await manager.cancel(context, fresh.id); expect((await manager.get(context, fresh.id)).state).toBe("cancelled"); expect(closes).toBe(2); expect(store.list()).toHaveLength(0);
  } finally { manager.close(); service.close(); rmSync(directory, { recursive: true, force: true }); }
});
