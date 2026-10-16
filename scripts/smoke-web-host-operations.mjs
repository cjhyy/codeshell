/** Production Web entry → actual standalone Host/Worker → owned streaming model. */
/* global window */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import http, { request as namedRequest } from "node:http";
import https from "node:https";
import { createWebHostOperationsFixture, waitFor } from "./fixtures/web-host-operations.mjs";
import { installLocalNetworkGuard } from "./runtime-cost-smoke-isolation.mjs";

const fixture = await createWebHostOperationsFixture();
const { chromium } = createRequire(join(fixture.repository, "packages/desktop/package.json"))(
  "playwright",
);
const errors = [],
  blocked = [],
  wire = [],
  sockets = [],
  operations = [];
let driverGuard;
let browser,
  page,
  stage = "launch browser",
  passed = false;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CODESHELL_TEST_CHROMIUM ||
      (process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : undefined),
  });
  // No Core runs in this driver. Its HTTP helpers may reach only the owned Host;
  // Host and Worker were guarded before import and can reach only the provider.
  installLocalNetworkGuard(fixture.url);
  let negativeProbes = 0;
  for (const probe of [
    () => fetch("https://example.invalid/denied"),
    () => fetch(fixture.providerOrigin + "/denied"),
    () => http.request("http://localhost:9/denied"),
    () => namedRequest("https://example.invalid/denied"),
    () => http.get(fixture.providerOrigin + "/denied"),
    () => https.request("https://example.invalid/denied"),
    () => https.get("https://example.invalid/denied"),
  ]) {
    assert.throws(probe, /refused a non-fixture request/);
    negativeProbes++;
  }
  driverGuard = { pid: process.pid, ppid: process.ppid, origin: fixture.url, negativeProbes };
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === fixture.url) return route.continue();
    blocked.push(url.origin + url.pathname);
    return route.abort();
  });
  await context.routeWebSocket("**/*", (route) => {
    const url = new URL(route.url());
    if (url.origin === fixture.url.replace("http:", "ws:") && url.pathname === "/ws")
      return route.connectToServer();
    blocked.push(url.origin + url.pathname);
    return route.close();
  });
  page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("websocket", (socket) => {
    sockets.push(socket.url());
    socket.on("framesent", ({ payload }) => {
      const message = JSON.parse(String(payload));
      wire.push({
        method: message.method,
        sessionId: message.params?.sessionId,
        clientMessageId: message.params?.clientMessageId,
        task: message.method === "agent/run" ? message.params?.task : undefined,
      });
    });
  });
  stage = "actual administrator setup through production Web entry";
  await page.goto(fixture.url + "/#setup=" + fixture.token);
  await page.getByRole("heading", { name: "创建管理员账号", exact: true }).waitFor();
  await page.getByLabel("用户名", { exact: true }).fill("owned-admin");
  await page.getByLabel("密码", { exact: true }).fill("owned-web-host-password-12345");
  await page.getByRole("button", { name: "创建并进入", exact: true }).click();
  const composer = page.getByRole("textbox", { name: "任务内容", exact: true });
  await composer.waitFor();
  await page.locator(".connection-pill .dot.open").waitFor();
  const send = async (task, reply) => {
    await composer.fill(task);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.locator(".messages").getByText(reply, { exact: true }).waitFor();
    await page.getByRole("button", { name: "停止", exact: true }).waitFor({ state: "hidden" });
    return new URL(page.url()).searchParams.get("session");
  };
  const select = async (sessionId) => {
    const summary = await page.evaluate(async (id) => {
      const response = await fetch("/api/v1/sessions");
      if (!response.ok) throw new Error("Actual session list read failed");
      return (await response.json()).sessions.find((s) => s.sessionId === id);
    }, sessionId);
    assert(summary, "Actual Host session must be persisted before selection");
    const title = summary.customTitle || summary.title;
    const button = page
      .locator(".sessions .session")
      .filter({ has: page.locator(".session-title").getByText(title, { exact: true }) });
    await button.click();
    await page.waitForFunction(
      (id) => new URL(window.location.href).searchParams.get("session") === id,
      sessionId,
    );
    await page.getByText("正在恢复会话记录…", { exact: true }).waitFor({ state: "hidden" });
  };
  const sessionA = await send("OWNED_INIT_A", "Saved OWNED_INIT_A.");
  assert(sessionA);
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  const sessionB = await send("OWNED_INIT_B", "Saved OWNED_INIT_B.");
  assert(sessionB && sessionB !== sessionA);
  await select(sessionA);

  stage = "actual upload 201 held → switch A to B → delayed response remains in A";
  console.log("WEB HOST stage: " + stage);
  const bytes = "Owned attachment bytes must remain in session A.\n";
  await composer.fill("OWNED_UPLOAD_A");
  await fixture.control("hold-next-upload");
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "owned-notes.txt", mimeType: "text/plain", buffer: Buffer.from(bytes) });
  await fixture.waitUpload();
  await page.getByText("正在上传…", { exact: true }).waitFor();
  assert(await page.getByRole("button", { name: "发送", exact: true }).isDisabled());
  await select(sessionB);
  await composer.fill("Owned B draft must remain");
  await fixture.control("release-upload");
  await waitFor(
    () => page.getByRole("button", { name: "添加附件", exact: true }).isEnabled(),
    "upload settles in inactive session",
  );
  assert.equal(await page.locator(".attachments").count(), 0);
  assert.equal(await composer.inputValue(), "Owned B draft must remain");
  await select(sessionA);
  await page.getByRole("button", { name: "移除 owned-notes.txt", exact: true }).waitFor();
  assert.equal(await composer.inputValue(), "OWNED_UPLOAD_A");
  assert.equal(
    await page.getByRole("button", { name: "移除 owned-notes.txt", exact: true }).count(),
    1,
  );
  await page.screenshot({
    path: join(fixture.evidence, "upload-late-success-origin-session.png"),
    animations: "disabled",
  });
  await send("OWNED_UPLOAD_A", "Owned attachment accepted.");
  const uploaded = fixture.requests.find((r) => r.marker === "OWNED_UPLOAD_A");
  assert(uploaded);
  const modelInput = JSON.stringify(uploaded.body.messages);
  assert(modelInput.includes("owned-notes.txt") && modelInput.includes(".code-shell/attachments/"));
  const filesA = await readdir(join(fixture.workspace, ".code-shell/attachments", sessionA));
  const attachment = filesA.find((file) => file.endsWith("-owned-notes.txt"));
  assert(attachment);
  assert.equal(
    await readFile(
      join(fixture.workspace, ".code-shell/attachments", sessionA, attachment),
      "utf8",
    ),
    bytes,
  );
  assert(
    !(await readdir(join(fixture.workspace, ".code-shell/attachments", sessionB)).catch((e) =>
      e.code === "ENOENT" ? null : Promise.reject(e),
    )),
  );
  await select(sessionB);
  assert.equal(await composer.inputValue(), "Owned B draft must remain");
  assert.equal(await page.locator(".attachments").count(), 0);
  operations.push({
    operation: "real-upload-late-success-stays-with-origin-session",
    sessionA,
    sessionB,
    bytes: Buffer.byteLength(bytes),
    stagedPath: relative(
      fixture.workspace,
      join(fixture.workspace, ".code-shell/attachments", sessionA, attachment),
    ),
  });
  await select(sessionA);

  stage = "actual Worker stream → owned WebSocket drop → missed journal replay → no repeated Run";
  console.log("WEB HOST stage: " + stage);
  await composer.fill("OWNED_RECONNECT");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.locator(".message-streaming").filter({ hasText: "Owned stream first." }).waitFor();
  const before = sockets.length;
  const dropped = await fixture.control("drop-websockets");
  assert.equal(dropped.count, 1, "Drop only the one owned browser WebSocket");
  await page.locator(".connection-pill .dot.closed").waitFor();
  fixture.middle();
  await composer.fill("Owned reconnect draft remains");
  assert(await page.getByRole("button", { name: "发送", exact: true }).isDisabled());
  await fixture.control("allow-reconnect");
  await page.locator(".connection-pill .dot.open").waitFor();
  await waitFor(() => sockets.length > before, "new actual browser WebSocket");
  await page
    .locator(".message-streaming")
    .filter({ hasText: "Owned stream first. Owned stream missed middle." })
    .waitFor();
  fixture.finish();
  const result = "Owned stream first. Owned stream missed middle. Owned stream final.";
  await page.locator(".messages").getByText(result, { exact: true }).waitFor();
  await page.getByRole("button", { name: "停止", exact: true }).waitFor({ state: "hidden" });
  assert.equal(await composer.inputValue(), "Owned reconnect draft remains");
  assert.equal(
    wire.filter((r) => r.method === "agent/run" && r.task === "OWNED_RECONNECT").length,
    1,
  );
  assert.equal(fixture.requests.filter((r) => r.marker === "OWNED_RECONNECT").length, 1);
  assert.equal(
    await page.locator(".messages").getByText("OWNED_RECONNECT", { exact: true }).count(),
    1,
  );
  await page.screenshot({
    path: join(fixture.evidence, "real-worker-stream-reconnected.png"),
    animations: "disabled",
  });
  operations.push({
    operation: "real-worker-stream-reconnect-recovers-missed-text-without-repeat",
    sessionId: sessionA,
    browserSocketsBefore: before,
    browserSocketsAfter: sockets.length,
    modelRequests: 1,
    runFrames: 1,
  });
  const receipts = await fixture.receipts();
  const processes = receipts.filter((r) => r.kind === "pre-core-network-guard");
  assert(processes.some((r) => r.pid === fixture.hostPid && r.negativeProbes === 7));
  assert(
    processes.some(
      (r) =>
        r.ppid === fixture.hostPid && /agent-server-stdio/.test(r.entry) && r.negativeProbes === 7,
    ),
  );
  for (const r of processes) assert.equal(r.origin, fixture.providerOrigin);
  for (const op of operations)
    if (op.stagedPath) assert(!isAbsolute(op.stagedPath) && !op.stagedPath.startsWith(".."));
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  assert.deepEqual(fixture.faults, []);
  passed = true;
} catch (error) {
  if (page)
    await page
      .screenshot({ path: join(fixture.evidence, "failure.png"), animations: "disabled" })
      .catch(() => {});
  console.error(`Web Host operations failed at ${stage}; evidence: ${fixture.evidence}`);
  console.error(fixture.safeLogs().slice(-4000));
  throw error;
} finally {
  await writeFile(
    join(fixture.evidence, "report.json"),
    JSON.stringify(
      {
        sourceHead: fixture.sourceHead,
        artifactHashes: fixture.artifactHashes,
        driverGuard,
        passed,
        stage,
        operations,
        wire,
        errors,
        blocked,
        providerFaults: fixture.faults,
        modelRequests: fixture.requests.map((r) => ({ marker: r.marker, model: r.body.model })),
        receipts: await fixture.receipts().catch(() => []),
        coverage:
          "Production compiled Web entry, native Chromium HTTP/WebSocket, unmodified Host request handlers, real stdio Engine Worker and staged attachment bytes. Provider is owned loopback SSE; only HTTP response end/owned WebSocket termination are fault controls. No external account, paid model, or real user data.",
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await browser?.close();
  await fixture.close();
}
console.log(`PASS Web real Host operations: 2 sequences; evidence: ${fixture.evidence}`);
