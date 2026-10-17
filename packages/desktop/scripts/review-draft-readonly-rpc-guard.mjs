/** Fixture-only admission for the existing production no-Worker read routes.
 * No reply, process or filesystem authority is created here. */
function installReadonlyReviewRpcGuard(ipcMain, sessionIds, record, refuse) {
  if (
    !Array.isArray(sessionIds) ||
    sessionIds.length !== 2 ||
    new Set(sessionIds).size !== 2 ||
    !sessionIds.every((id) => typeof id === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(id))
  )
    throw new Error("Expected two owned Review Session ids");
  const allowed = new Set(sessionIds);
  let admitted = 0;
  const on = ipcMain.on.bind(ipcMain);
  ipcMain.on = (channel, listener) =>
    on(
      channel,
      channel !== "agent:msg"
        ? listener
        : function (event, line) {
            let message;
            if (
              typeof line === "string" &&
              Buffer.byteLength(line) <= 4096 &&
              !/[\r\n]/.test(line)
            ) {
              try {
                message = JSON.parse(line);
              } catch {
                // Invalid frames receive fixed metadata, never their raw bytes.
              }
            }
            const object = (value) =>
              value !== null && typeof value === "object" && !Array.isArray(value);
            const method =
              object(message) &&
              typeof message.method === "string" &&
              /^agent\/[A-Za-z][A-Za-z0-9]{0,63}$/.test(message.method)
                ? message.method
                : "<invalid>";
            const params = object(message?.params) ? message.params : null;
            const sessionId =
              typeof params?.sessionId === "string" &&
              /^[A-Za-z0-9._-]{1,128}$/.test(params.sessionId)
                ? params.sessionId
                : "<invalid>";
            const id =
              typeof message?.id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(message.id)
                ? message.id
                : typeof message?.id === "number" &&
                    Number.isSafeInteger(message.id) &&
                    message.id >= 0
                  ? message.id
                  : null;
            const metadata = { method, sessionId, id };
            const keys = params ? Object.keys(params).sort().join(",") : "";
            const readonly =
              (method === "agent/goalGet" && keys === "sessionId") ||
              (method === "agent/backgroundWork" &&
                (keys === "sessionId" ||
                  (keys === "scope,sessionId" && ["session", "all"].includes(params.scope)))) ||
              (method === "agent/backgroundShells" &&
                keys === "action,sessionId" &&
                params.action === "list");
            if (
              !object(message) ||
              Object.keys(message).sort().join(",") !== "id,jsonrpc,method,params" ||
              message.jsonrpc !== "2.0" ||
              id === null ||
              !allowed.has(sessionId) ||
              !readonly ||
              admitted >= 128
            ) {
              refuse(metadata);
              throw new Error("Owned Review RPC refused");
            }
            admitted++;
            try {
              if (record(metadata) !== undefined)
                throw new Error("Review RPC metadata sink must be synchronous");
            } catch (error) {
              // Preserve the original IO failure, and latch the same denial path
              // used for forbidden requests even if this occurs after Main snapshot.
              try {
                refuse(metadata);
              } catch {
                // A failed refusal sink must not replace the original IO error.
              }
              throw error;
            }
            // Preserve the exact receiver, event, line and listener return/rejection.
            return listener.call(this, event, line);
          },
    );
}

/** Exact fragment inserted into the pre-Core native fixture guard and VM-tested. */
export function reviewDraftReadonlyRpcGuardSource(sessionIds) {
  return `(${installReadonlyReviewRpcGuard.toString()})(ipcMain, ${JSON.stringify(sessionIds)},
    (metadata) => {
      state.readonlyAgentRequests.push(metadata);
      return recordReviewIpc({kind:"readonly-agent-rpc",...metadata});
    },
    (metadata) => {
      if(state.agentMessages.length<16)state.agentMessages.push(metadata);
      return deny("agent:msg",metadata);
    });`;
}

/** Final durable metadata can extend the earlier Main snapshot during close.
 * Every admitted raw frame already passed the strict guard above. This rechecks
 * the final finite metadata schema and the complete unchanged snapshot prefix. */
export function reconcileReviewDraftReadonlyRpcLedger(sessionIds, snapshot, records) {
  const allowed = new Set(sessionIds);
  if (
    sessionIds.length !== 2 ||
    allowed.size !== 2 ||
    !sessionIds.every((id) => typeof id === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(id)) ||
    !Array.isArray(snapshot) ||
    !Array.isArray(records) ||
    snapshot.length > records.length ||
    records.length > 128
  )
    throw new Error("Invalid final Review RPC sequence");
  const validate = (row, durable) => {
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      Object.keys(row).sort().join(",") !==
        (durable ? "id,kind,method,sessionId" : "id,method,sessionId") ||
      (durable && row.kind !== "readonly-agent-rpc") ||
      !["agent/goalGet", "agent/backgroundWork", "agent/backgroundShells"].includes(row.method) ||
      !allowed.has(row.sessionId) ||
      !(
        (typeof row.id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(row.id)) ||
        (typeof row.id === "number" && Number.isSafeInteger(row.id) && row.id >= 0)
      )
    )
      throw new Error("Invalid final Review RPC metadata");
    return { method: row.method, sessionId: row.sessionId, id: row.id };
  };
  const requests = records.map((row) => validate(row, true));
  for (const [index, row] of snapshot.entries()) {
    const expected = validate(row, false);
    if (["method", "sessionId", "id"].some((key) => expected[key] !== requests[index][key]))
      throw new Error("Main Review RPC snapshot is not a durable prefix");
  }
  return {
    snapshotRecords: snapshot.length,
    lateRecords: requests.length - snapshot.length,
    requests,
  };
}
