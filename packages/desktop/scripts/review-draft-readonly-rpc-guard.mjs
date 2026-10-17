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
            if (record(metadata) !== undefined)
              throw new Error("Review RPC metadata sink must be synchronous");
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
