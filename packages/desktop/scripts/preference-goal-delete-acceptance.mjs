/** Fixture-only finite Goal admission and observation. No response, disk or process authority. */
function inspectRequest(input, config, armed) {
  if (typeof input !== "string" || Buffer.byteLength(input) > 4096 || /[\r\n]/.test(input))
    throw new Error("Invalid Goal fixture RPC frame");
  const request = JSON.parse(input);
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (
    !object(request) ||
    Object.keys(request).sort().join(",") !== "id,jsonrpc,method,params" ||
    request.jsonrpc !== "2.0" ||
    !(
      (typeof request.id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(request.id)) ||
      (Number.isSafeInteger(request.id) && request.id >= 0)
    ) ||
    !object(request.params) ||
    typeof request.params.sessionId !== "string" ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(request.params.sessionId)
  )
    throw new Error("Invalid Goal fixture RPC identity");
  const { method, params } = request;
  const keys = Object.keys(params).sort().join(",");
  const readonly =
    (method === "agent/goalGet" && keys === "sessionId") ||
    (method === "agent/backgroundWork" &&
      (keys === "sessionId" ||
        (keys === "scope,sessionId" && ["session", "all"].includes(params.scope)))) ||
    (method === "agent/backgroundShells" &&
      keys === "action,sessionId" &&
      params.action === "list");
  const deletion =
    armed &&
    method === "agent/goalDelete" &&
    params.sessionId === config.sessionIds[0] &&
    keys === "expectedGoalId,expectedRevision,sessionId" &&
    params.expectedGoalId === config.goalId &&
    params.expectedRevision === config.revision;
  if ((!readonly && !deletion) || (armed && !config.sessionIds.includes(params.sessionId)))
    throw new Error("Goal fixture refused an unreviewed request");
  return { request, deletion };
}

function installGuard(ipcMain, config, state, record, refuse, inspect, MessageChannelMain) {
  const observation = (state.goalDelete = { armed: false, rows: [], pending: 0, failures: [] });
  const seen = new Set();
  let deleted = false;
  const fail = () => {
    if (observation.failures.length < 16) observation.failures.push("Goal RPC observation failed");
    try {
      refuse();
    } catch {
      /* A failed diagnostic write cannot prevent sender restoration. */
    }
  };
  const note = (row) => {
    try {
      if (observation.rows.length >= 256) throw new Error("Goal RPC receipt cap");
      observation.rows.push(row);
      if (record(row) !== undefined) throw new Error("Goal RPC sink must be synchronous");
    } catch (error) {
      fail();
      throw error;
    }
  };
  const begin = (line) => {
    let admitted;
    try {
      admitted = inspect(line, config, observation.armed);
      if (admitted.deletion && deleted) throw new Error("Duplicate Goal deletion");
      if (!observation.armed) return;
      if (seen.has(admitted.request.id)) throw new Error("Duplicate Goal fixture request id");
    } catch (error) {
      fail();
      throw error;
    }
    const { request, deletion } = admitted;
    seen.add(request.id);
    if (deletion) deleted = true;
    note({ kind: "request", request });
    observation.pending++;
    return request;
  };

  // Workbench requests now reach the existing no-child handler on the private
  // Host/Main worker-control port. Observe the actual admission and its reply.
  const channel = new MessageChannelMain();
  const portType = Object.getPrototypeOf(channel.port1);
  channel.port1.close();
  channel.port2.close();
  const callsByPort = new WeakMap();
  const emit = portType.emit;
  portType.emit = function (eventName, ...args) {
    const data = args[0]?.data;
    if (eventName === "message" && data?.type === "renderer-prepare") {
      const { id, method, params } = data.request;
      const request = begin(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      if (request) {
        const calls = callsByPort.get(this) ?? new Map();
        callsByPort.set(this, calls);
        calls.set(data.call, request);
      }
    }
    return emit.call(this, eventName, ...args);
  };
  const post = portType.postMessage;
  portType.postMessage = function (message, ...args) {
    const calls = callsByPort.get(this);
    if (message?.type === "renderer-admitted" && calls?.has(message.call)) {
      const request = calls.get(message.call);
      calls.delete(message.call);
      observation.pending--;
      const reply = message.admission;
      if (reply.type !== "reply" || reply.error) {
        fail();
        throw Error("Expected a real no-worker Goal fallback reply");
      }
      note({
        kind: "response",
        response: { jsonrpc: "2.0", id: request.id, result: reply.result },
      });
    }
    return post.call(this, message, ...args);
  };
  const on = ipcMain.on.bind(ipcMain);
  ipcMain.on = (channel, listener) =>
    on(
      channel,
      channel !== "agent:msg"
        ? listener
        : function (event, line) {
            const request = begin(line);
            if (!request) return listener.call(this, event, line);
            let responses = 0;
            const send = event.sender.send;
            const observedSend = function (channel, responseLine, ...args) {
              if (channel === "agent:msg" && typeof responseLine === "string") {
                let response;
                try {
                  if (Buffer.byteLength(responseLine) > 4096) throw new Error("Goal response cap");
                  response = JSON.parse(responseLine);
                } catch (error) {
                  fail();
                  throw error;
                }
                if (response?.id === request.id) {
                  responses++;
                  note({ kind: "response", response });
                }
              }
              return send.call(this, channel, responseLine, ...args);
            };
            event.sender.send = observedSend;
            try {
              // Real no-child Goal fallbacks reply synchronously. Do not substitute a result.
              return listener.call(this, event, line);
            } finally {
              if (event.sender.send !== observedSend || responses !== 1) fail();
              event.sender.send = send;
              observation.pending--;
            }
          },
    );
}

export function preferenceGoalDeleteGuardSource(config) {
  if (
    config.sessionIds?.length !== 2 ||
    new Set(config.sessionIds).size !== 2 ||
    !config.sessionIds.every(
      (id) => typeof id === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(id),
    ) ||
    typeof config.goalId !== "string" ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(config.goalId) ||
    typeof config.ledger !== "string" ||
    !config.ledger ||
    config.ledger.includes("\0") ||
    !Number.isSafeInteger(config.revision) ||
    config.revision < 1
  )
    throw new Error("Expected two owned Goal sessions and an exact Goal version");
  return `(${installGuard.toString()})(ipcMain, ${JSON.stringify(config)}, state,
    row => appendFileSync(${JSON.stringify(config.ledger)}, JSON.stringify(row)+"\\n", {mode:0o600}),
    () => attempt("goal-rpc"), (${inspectRequest.toString()}), MessageChannelMain);`;
}

/** The final durable sequence may extend a Main snapshot during normal close. */
export function reconcilePreferenceGoalLedger(config, snapshot, rows) {
  if (
    !Array.isArray(snapshot) ||
    !Array.isArray(rows) ||
    rows.length > 256 ||
    rows.length % 2 ||
    snapshot.length > rows.length ||
    snapshot.some((row, index) => JSON.stringify(row) !== JSON.stringify(rows[index]))
  )
    throw new Error("Invalid final Goal RPC prefix");
  const requests = [],
    responses = [],
    ids = new Set();
  const pending = new Map();
  for (const row of rows) {
    if (row?.kind === "request" && Object.keys(row).sort().join(",") === "kind,request") {
      const { request } = inspectRequest(JSON.stringify(row.request), config, true);
      if (ids.has(request.id)) throw new Error("Duplicate Goal RPC request");
      ids.add(request.id);
      pending.set(request.id, requests.length);
      requests.push(request);
      continue;
    }
    if (row?.kind !== "response" || Object.keys(row).sort().join(",") !== "kind,response")
      throw new Error("Invalid Goal RPC pair");
    const response = row.response;
    const index = pending.get(response?.id);
    if (index === undefined) throw new Error("Unmatched Goal RPC response");
    const request = requests[index];
    const result = response?.result;
    const validResult =
      request.method === "agent/backgroundWork"
        ? result &&
          Object.keys(result).join(",") === "items" &&
          Array.isArray(result.items) &&
          result.items.length === 0
        : request.method === "agent/backgroundShells"
          ? result &&
            Object.keys(result).join(",") === "shells" &&
            Array.isArray(result.shells) &&
            result.shells.length === 0
          : result?.ok === true;
    if (
      !response ||
      response.id !== request.id ||
      response.jsonrpc !== "2.0" ||
      Object.keys(response).sort().join(",") !== "id,jsonrpc,result" ||
      !validResult
    )
      throw new Error("Invalid original Goal response");
    pending.delete(request.id);
    responses[index] = response;
  }
  if (pending.size) throw new Error("Unsettled Goal RPC request");
  const deletes = requests
    .map((request, index) => ({ request, response: responses[index] }))
    .filter((row) => row.request.method === "agent/goalDelete");
  if (deletes.length !== 1 || deletes[0].response.result.deleted !== true)
    throw new Error("Expected exactly one real successful Goal deletion");
  return { requests, responses, deletion: deletes[0], lateRows: rows.length - snapshot.length };
}
