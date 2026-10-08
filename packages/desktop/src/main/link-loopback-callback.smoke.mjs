import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

/** Accepts a compiled helper module path for packaged/runtime verification; no Electron or user data. */
export async function runLinkLoopbackCallbackSmoke(createBroker) {
  const reserve = createServer();
  await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const redirectUri = `http://127.0.0.1:${port}/link/callback`;
  const nonce = () => randomBytes(32).toString("base64url");
  const input = () => ({
    redirectUri,
    state: nonce(),
    expiresAt: Date.now() + 10_000,
    onCallback: () => true,
    onCancel() {},
  });
  const broker = createBroker({ port });
  let release, entered;
  const arrived = new Promise((resolve) => {
    entered = resolve;
  });
  const completed = new Promise((resolve) => {
    release = resolve;
  });
  let cancelled = 0;
  const flow = input();
  await broker.register({
    ...flow,
    onCancel() {
      cancelled++;
    },
    onCallback() {
      entered();
      return completed;
    },
  });
  await broker.register({
    ...input(),
    onCancel() {
      cancelled++;
    },
  });
  const callback = fetch(`${redirectUri}?state=${flow.state}&code=synthetic`);
  void callback.catch(() => {});
  await arrived;
  broker.close();
  assert.equal(cancelled, 2);
  await assert.rejects(callback);
  await assert.rejects(broker.register(input()), /已关闭/);
  release(false);
  await new Promise((resolve) => setTimeout(resolve, 10));

  const retry = createBroker({ port });
  const first = await retry.register(input());
  first.close();
  const abort = new AbortController();
  const interrupted = retry.register({ ...input(), signal: abort.signal });
  abort.abort();
  await assert.rejects(interrupted, /取消或过期/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const proof = createServer();
  await new Promise((resolve, reject) => {
    proof.once("error", reject);
    proof.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve) => proof.close(resolve));
  const active = await retry.register(input());
  active.close();
  const afterClose = retry.register(input());
  retry.close();
  await assert.rejects(afterClose, /取消或过期|已关闭/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const final = createServer();
  await new Promise((resolve, reject) => {
    final.once("error", reject);
    final.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve) => final.close(resolve));
  return { ok: true, globalClose: true, closingRace: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const moduleUrl = process.argv[2]
    ? pathToFileURL(process.argv[2])
    : new URL("./link-loopback-callback.ts", import.meta.url);
  const { createLinkLoopbackCallbackBroker } = await import(moduleUrl.href);
  console.log(JSON.stringify(await runLinkLoopbackCallbackSmoke(createLinkLoopbackCallbackBroker)));
}
