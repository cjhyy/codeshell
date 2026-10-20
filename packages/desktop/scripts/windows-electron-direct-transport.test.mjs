import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  createWindowsSourceMainIdentityReader,
  installWindowsElectronDirectTransport,
  knownPlaywrightElectronVector,
} from "./windows-electron-direct-transport.mjs";

function identityFixture() {
  const captured = { pid: 101 };
  const calls = [];
  const value = {
    pid: 101,
    ppid: 99,
    executable: "C:\\owned\\electron.exe",
    home: "C:\\owned\\home",
  };
  const connection = { _closed: false, _sessions: new Map() };
  const session = {
    _connection: connection,
    _sessionId: "",
    _closed: false,
    _crashed: false,
    async send(method, params) {
      calls.push({ method, params, receiver: this });
      return f.response();
    },
  };
  connection.rootSession = session;
  connection._sessions.set("", session);
  const context = { delegate: { _client: session, _contextId: 17 } };
  const handle = { _context: context, _disposed: false, _objectId: "owned module" };
  const implementation = {
    process: () => captured,
    _nodeConnection: connection,
    _nodeSession: session,
    _nodeExecutionContext: context,
    _nodeElectronHandlePromise: Promise.resolve(handle),
  };
  const application = {
    process: () => captured,
    evaluate() {
      throw Error("Public evaluation fallback is forbidden");
    },
    _connection: {
      toImpl(candidate) {
        assert.equal(candidate, application);
        return implementation;
      },
    },
  };
  const f = {
    captured,
    calls,
    value,
    connection,
    session,
    context,
    handle,
    implementation,
    application,
    response: () => ({ result: { type: "object", value } }),
    reader: (extra = {}) =>
      createWindowsSourceMainIdentityReader({
        application,
        captured,
        playwrightVersion: "1.64.0",
        platform: "win32",
        ...extra,
      }),
  };
  return f;
}

test("synchronous identity borrows one existing Main session and sends only a fixed nonawaiting read", async () => {
  const f = identityFixture();
  const read = await f.reader();
  const actual = await read();
  assert.deepEqual(actual, f.value);
  assert.notEqual(actual, f.value);
  assert.deepEqual(f.calls, [
    {
      method: "Runtime.evaluate",
      receiver: f.session,
      params: {
        expression:
          "({pid:process.pid,ppid:process.ppid,executable:process.execPath,home:process.env.HOME})",
        contextId: 17,
        returnByValue: true,
        awaitPromise: false,
      },
    },
  ]);
  f.value.home = "C:\\changed\\home";
  assert.equal(actual.home, "C:\\owned\\home", "Returned identity is copied");
});

test("synchronous identity rejects unsupported versions, remote clients and foreign Main references before send", async () => {
  for (const mutate of [
    (f) => f.reader({ playwrightVersion: "1.65.0" }),
    (f) => f.reader({ platform: "linux" }),
    (f) => {
      delete f.application._connection.toImpl;
      return f.reader();
    },
    (f) => {
      f.implementation.process = () => ({ pid: 101 });
      return f.reader();
    },
    (f) => {
      f.application.process = () => ({ pid: 101 });
      return f.reader();
    },
    (f) => {
      f.implementation._nodeElectronHandlePromise = null;
      return f.reader();
    },
  ]) {
    const f = identityFixture();
    await assert.rejects(mutate(f));
    assert.equal(f.calls.length, 0);
  }
});

test("synchronous identity refuses changed protocol and context bindings without reacquiring or retrying", async () => {
  for (const mutate of [
    (f) => {
      f.application._connection = {};
    },
    (f) => {
      f.application._connection.toImpl = () => f.implementation;
    },
    (f) => {
      f.implementation._nodeConnection = {};
    },
    (f) => {
      f.connection.rootSession = {};
    },
    (f) => {
      f.connection._sessions.set("", {});
    },
    (f) => {
      f.session._connection = {};
    },
    (f) => {
      f.session._sessionId = "foreign";
    },
    (f) => {
      f.connection._closed = true;
    },
    (f) => {
      f.session._closed = true;
    },
    (f) => {
      f.session._crashed = true;
    },
    (f) => {
      f.implementation._nodeExecutionContext = { delegate: f.context.delegate };
    },
    (f) => {
      f.context.delegate = { _client: f.session, _contextId: 17 };
    },
    (f) => {
      f.context.delegate._contextId = 18;
    },
    (f) => {
      f.context.delegate._client = {};
    },
    (f) => {
      f.handle._disposed = true;
    },
    (f) => {
      f.handle._context = {};
    },
  ]) {
    const f = identityFixture();
    const read = await f.reader();
    mutate(f);
    await assert.rejects(read());
    assert.equal(f.calls.length, 0);
  }
  const f = identityFixture();
  const read = await f.reader();
  f.response = () => {
    f.context.delegate._contextId = 18;
    return { result: { type: "object", value: f.value } };
  };
  await assert.rejects(read(), /context ID changed/);
  assert.equal(f.calls.length, 1);
});

test("synchronous identity rejects exceptions and malformed or remote-object responses after one read", async () => {
  const getter = Object.defineProperty({}, "result", {
    get() {
      throw Error("must not run getter");
    },
  });
  for (const response of [
    {},
    { exceptionDetails: { text: "owned error" }, result: { type: "undefined" } },
    { result: { type: "object", subtype: "promise", objectId: "remote" } },
    { result: { type: "object", objectId: "remote", value: {} } },
    { result: { type: "object", value: null } },
    {
      result: {
        type: "object",
        value: { pid: 101, ppid: 99, executable: "C:\\owned", home: "C:\\owned", extra: true },
      },
    },
    {
      result: { type: "object", value: { pid: 101, ppid: 99, executable: "C:\\owned", home: "" } },
    },
    {
      result: {
        type: "object",
        value: { pid: 0, ppid: 99, executable: "C:\\owned", home: "C:\\owned" },
      },
    },
    getter,
  ]) {
    const f = identityFixture();
    const read = await f.reader();
    f.response = () => response;
    await assert.rejects(read());
    assert.equal(f.calls.length, 1);
  }
});

test("synchronous identity propagates the original protocol failure once without a public-evaluate fallback", async () => {
  const f = identityFixture();
  const read = await f.reader();
  const original = Error("owned protocol rejection");
  f.response = () => {
    throw original;
  };
  await assert.rejects(read(), (error) => error === original);
  assert.equal(f.calls.length, 1);
});

test("synchronous identity waits for the existing module handle and refuses a different resolved context", async () => {
  const f = identityFixture();
  let resolveHandle;
  f.implementation._nodeElectronHandlePromise = new Promise((resolve) => {
    resolveHandle = resolve;
  });
  const pending = f.reader();
  assert.equal(f.calls.length, 0);
  f.implementation._nodeExecutionContext = { delegate: f.context.delegate };
  resolveHandle(f.handle);
  await assert.rejects(pending, /handle has another context/);
  assert.equal(f.calls.length, 0);
});

function fixture({ loader, pid = 101 } = {}) {
  const calls = [],
    failures = [];
  const child = Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null });
  let settle;
  const completed = new Promise((resolve) => {
    settle = resolve;
  });
  let terminationCount = 0,
    captureCount = 0;
  const monitor = {
    completed,
    terminate() {
      terminationCount++;
      return completed;
    },
  };
  const children = {
    spawn(...args) {
      calls.push({ method: "spawn", args });
      return child;
    },
    spawnSync(...args) {
      calls.push({ method: "spawnSync", args });
      return { status: 42 };
    },
  };
  const context = {
    executable: "C:\\Owned 目录\\App & tools\\electron.exe",
    args: [
      "--inspect-brk=0",
      "--user-data-dir=C:\\Owned 目录\\100% literal!\\data",
      'literal"quoted\\suffix',
    ],
    home: "C:\\Owned 目录\\home",
    cwd: "C:\\Owned 目录\\home",
    ...(loader ? { loader } : {}),
    platform: "win32",
    reportFailure: (message) => failures.push(message),
    onCapturedSpawn(value) {
      assert.equal(value, child);
      captureCount++;
      return monitor;
    },
  };
  const originalSpawn = children.spawn,
    originalSpawnSync = children.spawnSync;
  const transport = installWindowsElectronDirectTransport(context, {
    children,
    syncExports: () => {},
  });
  const vector = knownPlaywrightElectronVector(context);
  const options = {
    env: { HOME: context.home, USERPROFILE: context.home },
    cwd: context.cwd,
    shell: true,
    detached: false,
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
  };
  return {
    children,
    child,
    monitor,
    transport,
    vector,
    context,
    options,
    calls,
    failures,
    originalSpawn,
    originalSpawnSync,
    counts: () => ({ terminationCount, captureCount }),
    settle: () =>
      settle({
        status: "cleaned",
        owned: [{ pid, ppid: 99, birth: "fixture-full-birth" }],
        remaining: [],
        remainingCount: 0,
      }),
  };
}

for (const loader of [undefined, "C:\\Owned modules\\Playwright目录\\loader.js"]) {
  test(`exact ${loader ? "source loader" : "packaged"} Windows vector becomes one direct Main without interpreting quotes`, () => {
    const f = fixture({ loader });
    try {
      // Independent golden from installed Playwright's literal quote/order,
      // not generated by the formatter being tested.
      const golden = loader
        ? String.raw`"C:\Owned 目录\App & tools\electron.exe" "-r" "C:\Owned modules\Playwright目录\loader.js" "--inspect=0" "--remote-debugging-port=0" "--inspect-brk=0" "--user-data-dir=C:\Owned 目录\100% literal!\data" "literal\"quoted\suffix"`
        : String.raw`"C:\Owned 目录\App & tools\electron.exe" "--inspect=0" "--remote-debugging-port=0" "--inspect-brk=0" "--user-data-dir=C:\Owned 目录\100% literal!\data" "literal\"quoted\suffix"`;
      assert.equal(f.vector.command, golden);
      const child = f.children.spawn(golden, [], f.options);
      assert.equal(child, f.child);
      assert.equal(f.calls.length, 1);
      assert.deepEqual(f.calls[0].args, [
        f.context.executable,
        f.vector.argv,
        { ...f.options, shell: false, windowsVerbatimArguments: false },
      ]);
      assert.equal(f.calls[0].args[1].at(-1), 'literal"quoted\\suffix');
      assert.match(f.vector.command, /literal\\"quoted/);
      if (loader)
        assert.deepEqual(f.vector.argv.slice(0, 4), [
          "-r",
          loader,
          "--inspect=0",
          "--remote-debugging-port=0",
        ]);
      assert.equal(f.counts().captureCount, 1);
      assert.deepEqual(f.transport.receipt().failures, []);
    } finally {
      f.transport.restoreSpawn();
    }
    assert.equal(f.children.spawn, f.originalSpawn);
    assert.notEqual(
      f.children.spawnSync,
      f.originalSpawnSync,
      "retired PID cleanup guard remains installed",
    );
  });
}

test("changed command/args/options and foreign HOME never reach a shell or receive capture authority", () => {
  const mutations = [
    (f) => [f.vector.command + " & calc.exe", [], f.options],
    (f) => [f.vector.command, ["--require=foreign"], f.options],
    (f) => [f.vector.command.replace("--inspect-brk=0", "--require=foreign"), [], f.options],
    (f) => [f.vector.command, [], { ...f.options, shell: false }],
    (f) => [f.vector.command, [], { ...f.options, shell: "cmd.exe" }],
    (f) => [f.vector.command, [], { ...f.options, cwd: "C:\\foreign" }],
    (f) => [f.vector.command, [], { ...f.options, env: { ...f.options.env, HOME: "C:\\foreign" } }],
    (f) => [
      f.vector.command,
      [],
      { ...f.options, env: { ...f.options.env, USERPROFILE: "C:\\foreign" } },
    ],
    (f) => [f.vector.command, [], { ...f.options, detached: true }],
    (f) => [f.vector.command, [], { ...f.options, windowsVerbatimArguments: true }],
    (f) => [f.vector.command, [], { ...f.options, stdio: ["ignore", "pipe", "pipe"] }],
  ];
  for (const mutate of mutations) {
    const f = fixture();
    try {
      assert.throws(() => f.children.spawn(...mutate(f)), /non-exact/);
      assert.equal(f.calls.length, 0);
      assert.equal(f.counts().captureCount, 0);
      assert.equal(f.failures.length, 1);
      assert.equal(f.transport.receipt().unsafeFallbackDenied, true);
    } finally {
      f.transport.restoreSpawn();
    }
  }
});

test("literal library taskkill is suppressed throughout lifetime and waits for actual custody proof", async () => {
  const f = fixture();
  f.children.spawn(f.vector.command, [], f.options);
  f.transport.restoreSpawn();
  const denied = f.children.spawnSync(`taskkill /pid ${f.child.pid} /T /F`, {
    shell: true,
    windowsHide: true,
  });
  assert.equal(denied.status, null, "suppression cannot pretend native command success");
  assert.match(denied.error.message, /suppressed/);
  assert.equal(f.calls.filter((call) => call.method === "spawnSync").length, 0);
  assert.equal(f.counts().terminationCount, 1);
  assert.equal(f.transport.receipt().cleanupRequests[0].settlement, null);
  f.settle();
  await f.monitor.completed;
  await Promise.resolve();
  assert.equal(f.transport.receipt().cleanupRequests[0].settlement.status, "cleaned");
  f.child.exitCode = 0;
  f.children.spawnSync(`taskkill /pid ${f.child.pid} /T /F`, { shell: true, windowsHide: true });
  assert.equal(
    f.calls.filter((call) => call.method === "spawnSync").length,
    0,
    "retired PID never reaches taskkill",
  );
  assert.equal(f.children.spawnSync("fixed-metadata.exe", [], { shell: false }).status, 42);
});

test("unknown/changed taskkill or missing authority is denied and remains a recorded failure", () => {
  const f = fixture();
  f.children.spawn(f.vector.command, [], f.options);
  f.transport.restoreSpawn();
  for (const args of [
    [`taskkill /pid 999 /T /F`, { shell: true, windowsHide: true }],
    [`taskkill /pid ${f.child.pid} /T /F & calc.exe`, { shell: true, windowsHide: true }],
    [`taskkill /pid ${f.child.pid} /T /F`, [], { shell: true, windowsHide: true }],
    [`taskkill /pid ${f.child.pid} /T /F`, { shell: false, windowsHide: true }],
  ])
    assert.throws(() => f.children.spawnSync(...args), /Refused/);
  assert.equal(f.counts().terminationCount, 0);
  assert.equal(f.calls.filter((call) => call.method === "spawnSync").length, 0);
  assert.equal(f.failures.length, 4);
  const g = fixture();
  g.context.onCapturedSpawn = () => {
    throw Error("initial identity unavailable");
  };
  // Install a new context using the same fake process transport.
  g.transport.restoreSpawn();
  const noAuthority = installWindowsElectronDirectTransport(g.context, {
    children: g.children,
    syncExports: () => {},
  });
  try {
    assert.throws(() => g.children.spawn(g.vector.command, [], g.options), /identity unavailable/);
    assert.throws(
      () =>
        g.children.spawnSync(`taskkill /pid ${g.child.pid} /T /F`, {
          shell: true,
          windowsHide: true,
        }),
      /without captured birth/,
    );
    assert.equal(g.counts().terminationCount, 0);
  } finally {
    noAuthority.restoreSpawn();
  }
});

test("PID reuse cannot redirect an old library cleanup to a new incarnation", () => {
  const f = fixture();
  f.children.spawn(f.vector.command, [], f.options);
  f.transport.restoreSpawn();
  f.child.exitCode = 0;
  let newCapture = 0,
    newTerminate = 0;
  const next = Object.assign(new EventEmitter(), {
    pid: f.child.pid,
    exitCode: null,
    signalCode: null,
  });
  f.children.spawn = () => next;
  const transport = installWindowsElectronDirectTransport(
    {
      ...f.context,
      onCapturedSpawn() {
        newCapture++;
        return {
          completed: new Promise(() => {}),
          terminate() {
            newTerminate++;
          },
        };
      },
    },
    { children: f.children, syncExports: () => {} },
  );
  try {
    assert.throws(() => f.children.spawn(f.vector.command, [], f.options), /PID was reused/);
    assert.equal(newCapture, 1, "new child still receives its own early custody before failing");
    assert.throws(
      () =>
        f.children.spawnSync(`taskkill /pid ${next.pid} /T /F`, { shell: true, windowsHide: true }),
      /PID-ambiguous/,
    );
    assert.equal(newTerminate, 0);
    assert.equal(f.counts().terminationCount, 0);
  } finally {
    transport.restoreSpawn();
  }
});

test("unreviewed versions and malformed expected paths are rejected before interception", () => {
  assert.throws(
    () => knownPlaywrightElectronVector({ executable: "relative", args: [] }),
    /Canonical/,
  );
  const f = fixture();
  f.transport.restoreSpawn();
  assert.throws(
    () =>
      installWindowsElectronDirectTransport(
        { ...f.context, playwrightVersion: "1.65.0" },
        { children: f.children, syncExports: () => {} },
      ),
    /Unreviewed/,
  );
  assert.throws(
    () =>
      installWindowsElectronDirectTransport(
        { ...f.context, platform: "linux" },
        { children: f.children, syncExports: () => {} },
      ),
    /Windows/,
  );
});

test("unproven/rejected/throwing custody cannot become native cleanup success", async () => {
  for (const kind of ["unproven", "reject", "throw"]) {
    const f = fixture();
    f.children.spawn(f.vector.command, [], f.options);
    f.transport.restoreSpawn();
    f.monitor.terminate = () => {
      if (kind === "throw") throw Error("custody threw");
      if (kind === "reject") return Promise.reject(Error("custody rejected"));
      return Promise.resolve({ status: "unproven", remaining: null });
    };
    const call = () =>
      f.children.spawnSync(`taskkill /pid ${f.child.pid} /T /F`, {
        shell: true,
        windowsHide: true,
      });
    if (kind === "throw") assert.throws(call, /custody threw/);
    else assert.equal(call().status, null);
    await Promise.resolve();
    await Promise.resolve();
    const receipt = f.transport.receipt();
    assert.ok(receipt.failures.length >= 2);
    assert.equal(receipt.unsafeFallbackDenied, true);
    assert.equal(receipt.nativeTaskkillExecuted, false);
    assert.equal(f.calls.filter((call) => call.method === "spawnSync").length, 0);
  }
});
