import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const installedVersion = require("playwright-core/package.json").version;
export const reviewedPlaywrightElectronVersion = "1.64.0";

/** Fixed synchronous read on the existing in-process Playwright Main session.
 * Avoid public evaluate's awaitPromise path for these four synchronous fields.
 * Bind once; never reacquire a context, replay a read or fall back to evaluation. */
export async function createElectronMainIdentityReader({
  application,
  captured,
  playwrightVersion = installedVersion,
  platform = process.platform,
}) {
  assert.ok(["win32", "linux", "darwin"].includes(platform), "Unsupported Main identity platform");
  assert.equal(
    installedVersion,
    reviewedPlaywrightElectronVersion,
    "Unreviewed installed Playwright identity version",
  );
  assert.equal(playwrightVersion, installedVersion, "Unreviewed Playwright identity version");
  assert.ok(
    Number.isSafeInteger(captured?.pid) && captured.pid > 0,
    "Captured Main PID is required",
  );
  const client = application?._connection;
  const toImpl = client?.toImpl;
  assert.equal(typeof toImpl, "function", "Main identity requires in-process Playwright");
  const implementation = toImpl.call(client, application);
  const publicProcess = application.process;
  const serverProcess = implementation?.process;
  assert.equal(typeof publicProcess, "function", "Public Main process reference is missing");
  assert.equal(typeof serverProcess, "function", "Server Main process reference is missing");
  assert.equal(
    publicProcess.call(application),
    captured,
    "Public Main differs from captured child",
  );
  assert.equal(
    serverProcess.call(implementation),
    captured,
    "Server Main differs from captured child",
  );
  const connection = implementation._nodeConnection;
  const session = implementation._nodeSession;
  const handlePromise = implementation._nodeElectronHandlePromise;
  assert.ok(
    handlePromise instanceof Promise && typeof handlePromise.then === "function",
    "Main context handle promise is missing",
  );
  assert.ok(connection && session, "Existing Main protocol connection is missing");
  const send = session.send;
  assert.equal(typeof send, "function", "Existing Main protocol send is missing");
  const handle = await handlePromise;
  const context = implementation._nodeExecutionContext;
  const delegate = context?.delegate;
  const contextId = delegate?._contextId;
  assert.ok(Number.isSafeInteger(contextId) && contextId > 0, "Default Main context is missing");
  const sameBinding = () => {
    assert.equal(application._connection, client, "Main client connection changed");
    assert.equal(client.toImpl, toImpl, "Main implementation mapping changed");
    assert.equal(toImpl.call(client, application), implementation, "Main implementation changed");
    assert.equal(application.process, publicProcess, "Public Main process method changed");
    assert.equal(implementation.process, serverProcess, "Server Main process method changed");
    assert.equal(
      publicProcess.call(application),
      captured,
      "Public Main differs from captured child",
    );
    assert.equal(
      serverProcess.call(implementation),
      captured,
      "Server Main differs from captured child",
    );
    assert.equal(implementation._nodeConnection, connection, "Main protocol connection changed");
    assert.equal(implementation._nodeSession, session, "Main protocol session changed");
    assert.equal(connection.rootSession, session, "Main protocol root session changed");
    assert.ok(connection._sessions instanceof Map, "Main protocol session registry is missing");
    assert.equal(connection._sessions.get(""), session, "Main root session registry changed");
    assert.equal(session._connection, connection, "Main protocol session connection changed");
    assert.equal(session._sessionId, "", "Main protocol session is not the root");
    assert.equal(connection._closed, false, "Main protocol connection is closed");
    assert.equal(session._closed, false, "Main protocol session is closed");
    assert.equal(session._crashed, false, "Main protocol session crashed");
    assert.equal(session.send, send, "Main protocol send changed");
    assert.equal(
      implementation._nodeElectronHandlePromise,
      handlePromise,
      "Main handle promise changed",
    );
    assert.equal(implementation._nodeExecutionContext, context, "Default Main context changed");
    assert.equal(context.delegate, delegate, "Default Main context delegate changed");
    assert.equal(delegate._client, session, "Default Main context has another session");
    assert.equal(delegate._contextId, contextId, "Default Main context ID changed");
    assert.equal(handle?._context, context, "Main module handle has another context");
    assert.equal(handle?._disposed, false, "Main module handle was disposed");
    assert.ok(
      typeof handle?._objectId === "string" && handle._objectId.length > 0,
      "Main module handle is missing",
    );
  };
  sameBinding();
  const data = (value, label) => {
    assert.ok(
      value && Object.getPrototypeOf(value) === Object.prototype,
      `${label} must be plain data`,
    );
    const fields = Object.getOwnPropertyDescriptors(value);
    assert.ok(
      Reflect.ownKeys(fields).every((key) => typeof key === "string" && "value" in fields[key]),
      `${label} must contain own data fields`,
    );
    return fields;
  };
  return async () => {
    sameBinding();
    const response = await send.call(session, "Runtime.evaluate", {
      expression:
        "({pid:process.pid,ppid:process.ppid,executable:process.execPath,home:process.env.HOME})",
      contextId,
      returnByValue: true,
      awaitPromise: false,
    });
    sameBinding();
    const envelope = data(response, "Main identity response");
    assert.deepEqual(
      Object.keys(envelope),
      ["result"],
      "Main identity evaluation raised an exception or malformed response",
    );
    const remote = data(envelope.result.value, "Main identity remote result");
    assert.ok(
      Object.keys(remote).every((key) =>
        ["type", "value", "className", "description"].includes(key),
      ),
      "Main identity must be returned by value",
    );
    assert.equal(remote.type?.value, "object", "Main identity result is not an object");
    const value = remote.value?.value;
    const fields = data(value, "Main identity value");
    assert.deepEqual(
      Object.keys(fields).sort(),
      ["executable", "home", "pid", "ppid"],
      "Main identity must have exactly four fields",
    );
    for (const key of ["pid", "ppid"])
      assert.ok(
        Number.isSafeInteger(fields[key].value) && fields[key].value > 0,
        `Main identity ${key} is invalid`,
      );
    for (const key of ["executable", "home"])
      assert.ok(
        typeof fields[key].value === "string" &&
          fields[key].value.length > 0 &&
          fields[key].value.length <= 4096 &&
          !/[\r\n\0]/.test(fields[key].value),
        `Main identity ${key} is invalid`,
      );
    return Object.fromEntries(
      ["pid", "ppid", "executable", "home"].map((key) => [key, fields[key].value]),
    );
  };
}
