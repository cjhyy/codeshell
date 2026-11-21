import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

/** Pair one synthetic device with the fixture's loopback-only Desktop gateway. */
export async function verifyPairedHostTerminal(page, terminalId, pid) {
  const pairing = await page.evaluate(() => window.codeshell.mobileRemote.start({ mode: "lan" }));
  const url = new URL(pairing.pairingUrl);
  assert.equal(url.hostname, "127.0.0.1");
  const socket = new WebSocket(`ws://${url.host}/ws`);
  const messages = [];
  socket.addEventListener("message", ({ data }) => messages.push(JSON.parse(data)));
  const send = (value) => socket.send(JSON.stringify(value));
  async function receive(type, predicate = () => true) {
    const deadline = Date.now() + 7000;
    do {
      const index = messages.findIndex((event) => event.type === type && predicate(event));
      if (index >= 0) return messages.splice(index, 1)[0];
      await delay(15);
    } while (Date.now() < deadline);
    throw new Error(
      `Missing ${type} from paired terminal. Received ${messages.map(({ type }) => type)}`,
    );
  }
  try {
    await once(socket, "open", { signal: AbortSignal.timeout(5000) });
    send({
      type: "pair.complete",
      token: url.searchParams.get("pairing"),
      name: "Host smoke phone",
      secretHash: "synthetic-host-terminal-fixture",
    });
    await receive("pair.ok");
    send({ type: "terminal.list" });
    const off = await receive("terminal.list.ok");
    assert.equal(off.enabled, false);
    assert.deepEqual(off.terminals, []);
    assert.equal(
      await page.evaluate(() => window.codeshell.mobileRemote.setTerminalAccess(true)),
      true,
    );
    const list = await receive("terminal.list.ok", (event) => event.enabled);
    assert.equal(list.terminals.find((term) => term.id === terminalId)?.pid, pid);
    await page.evaluate((id) => {
      window.hostRemoteViewers = [];
      window.codeshell.onPtyRemoteViewers((event) => {
        if (event.sessionId === id) window.hostRemoteViewers.push(event.count);
      });
    }, terminalId);
    send({ type: "terminal.open", terminalId, requestId: "attach-desktop", cols: 80, rows: 24 });
    const opened = await receive(
      "terminal.opened",
      (event) => event.requestId === "attach-desktop",
    );
    assert.equal(opened.terminal.pid, pid);
    assert.match(opened.replay, /HOST_TERMINAL_READY/);
    await page.waitForFunction(() => window.hostRemoteViewers.at(-1) === 1);
    send({ type: "terminal.input", terminalId, data: "echo PAIRED_SHELL_ECHO\r" });
    await page.waitForFunction(() =>
      window.hostTerminalText.replace(/\r/g, "").includes("\nPAIRED_SHELL_ECHO\n"),
    );
    let output = "";
    while (!output.replace(/\r/g, "").includes("\nPAIRED_SHELL_ECHO\n"))
      output += (await receive("terminal.data", (event) => event.terminalId === terminalId)).data;
    await page.evaluate(() => window.codeshell.mobileRemote.setTerminalAccess(false));
    await receive("terminal.list.ok", (event) => !event.enabled);
    await page.waitForFunction(() => window.hostRemoteViewers.at(-1) === 0);
    send({ type: "terminal.open", terminalId, requestId: "after-revoke", cols: 80, rows: 24 });
    assert.equal(
      (await receive("terminal.error", (event) => event.requestId === "after-revoke")).code,
      "disabled",
    );
    console.log(
      "Paired loopback device verified the Desktop shell PID, replay, two-way output and access revocation.",
    );
  } finally {
    socket.close();
    await page.evaluate(() => window.codeshell.mobileRemote.stop());
  }
}
