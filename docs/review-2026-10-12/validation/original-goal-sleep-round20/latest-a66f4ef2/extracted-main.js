function maintainedMainCallbackBinding() {
  ipcMain.on("agent:msg", (event, line) => {
    let prepared;
    try {
      prepared = prepareAgentRunMetadata(line, { origin: "renderer", producer: "agent:msg" }, this.agentRunMetadataDeps());
    } catch (error) {
      if (error instanceof AgentRunMetadataError) {
        let id;
        try {
          id = JSON.parse(line).id;
        } catch {
          id = undefined;
        }
        if (id !== undefined && !event.sender.isDestroyed()) {
          event.sender.send("agent:msg", JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: error.code, message: error.message }
          }));
        }
        return;
      }
      throw error;
    }
    const parsed = prepared.parsed;
    if (isOptimizationLabQuery(parsed)) {
      if (parsed.id !== undefined && !event.sender.isDestroyed()) {
        event.sender.send("agent:msg", JSON.stringify({
          jsonrpc: "2.0",
          id: parsed.id,
          error: {
            code: -32601,
            message: "Optimization Lab requires the dedicated local application bridge"
          }
        }));
      }
      return;
    }
    const externalGoalReply = this.externalGoalRpcHandler?.(parsed, event.sender.id);
    if (externalGoalReply) {
      externalGoalReply.then((reply) => {
        if (parsed.id !== undefined && !event.sender.isDestroyed()) {
          event.sender.send("agent:msg", JSON.stringify(reply));
        }
      });
      return;
    }
    if (parsed.method === "agent/run" && (this.webConfiguration.runBlocked || prepared.sessionId && this.sessionMainRootMigrationClaims.has(prepared.sessionId))) {
      if (parsed.id !== undefined && !event.sender.isDestroyed()) {
        event.sender.send("agent:msg", JSON.stringify({
          jsonrpc: "2.0",
          id: parsed.id,
          error: {
            code: ErrorCodes.Overloaded,
            message: this.webConfiguration.runBlocked ? "配置正在更新，请稍后重试。" : `Session ${prepared.sessionId} root migration is in progress; retry the run`
          }
        }));
      }
      return;
    }
    let outLine = line;
    const quickChatRunId = quickChatRunSessionId(parsed);
    if (quickChatRunId) {
      const request = quickChatRunRequest(parsed, event.sender.id);
      if (!request || this.quickChatForkLifecycle?.isClaimActive?.(request) !== true) {
        if (parsed.id !== undefined && !event.sender.isDestroyed()) {
          event.sender.send("agent:msg", JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            error: { code: -32602, message: "quick-chat claim is no longer active" }
          }));
        }
        return;
      }
    }
    const quickChatFork = quickChatForkRequest(parsed, event.sender.id);
    let quickChatForkWireId;
    if (quickChatFork && this.quickChatForkRouter) {
      const started = this.quickChatForkRouter.start(quickChatFork, event.sender, line);
      if (!started)
        return;
      outLine = started.line;
      quickChatForkWireId = started.wireId;
    }
    if (parsed.method === "agent/run") {
      outLine = this.handleAgentRunMetadata(prepared);
      const owner = BrowserWindow.fromWebContents(event.sender);
      if (prepared.sessionId && owner && this.windows.has(owner)) {
        this.claimSessionPanelOwner(prepared.sessionId, event.sender.id);
      }
    } else {
      const forkSourceId = forkSourceSessionId(parsed);
      if (forkSourceId) {
        this.core.ensureWorker(this.sessionsForFallback().readSessionMainRoot(forkSourceId));
      }
      const compactSessionId = compactQuerySessionId(parsed);
      if (compactSessionId) {
        this.core.ensureWorker(this.sessionsForFallback().readSessionMainRoot(compactSessionId) ?? parsed.params?.cwd);
      }
    }
    if (!this.core.canSend()) {
      if (parsed.method === "agent/run" && prepared.sessionId) {
        getSessionCwdIndex().evictTentative(prepared.sessionId);
        if (prepared.parsed.id !== undefined) {
          this.tentativeRunsByRequest.delete(String(prepared.parsed.id));
        }
      }
      const fallback = buildNoChildFallbackReply(parsed, this.sessionsForFallback());
      if (fallback !== null) {
        this.safeSend("agent:msg", fallback);
      }
      dlog("bridge", "renderer→worker.dropped", {
        reason: this.core.hasChild() ? "stdin destroyed" : "no child",
        method: parsed.method,
        answered: fallback !== null
      });
      if (quickChatForkWireId) {
        this.quickChatForkRouter?.fail(quickChatForkWireId).catch((error) => dlog("bridge", "quick_chat.fork_settle_failed", { error: String(error) }));
      }
      return;
    }
    dlog("bridge", "renderer→worker", { method: parsed.method, raw: previewLine(outLine) });
    try {
      if (!this.core.sendLine(outLine) && parsed.id !== undefined) {
        this.webConfiguration.settleRun(parsed.id);
      }
    } catch (error) {
      if (parsed.id !== undefined) {
        this.webConfiguration.settleRun(parsed.id);
        this.safeSend("agent:msg", JSON.stringify({
          jsonrpc: "2.0",
          id: parsed.id,
          error: { code: -32603, message: "无法向任务进程发送请求，请重试。" }
        }));
      }
      dlog("bridge", "renderer.write_failed", { error: String(error) });
    }
  });
}
return maintainedMainCallbackBinding;
