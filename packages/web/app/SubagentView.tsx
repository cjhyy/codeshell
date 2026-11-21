import React from "react";
import type { RemoteApp } from "../src/hooks/useRemoteApp.js";
import type { ChatItem } from "../src/lib/streamReducer.js";
import {
  SUBAGENT_GROUPS,
  roomAgentItems,
  subagentListItems,
  subagentRows,
  type SubagentListItem,
} from "../src/hooks/useRemoteSubagents.js";
import type { WorkbenchController } from "./workbench-types.js";
import { AnswerContent } from "./AnswerContent.js";
import { MessageContent, subagentStatusLabel } from "./MessageContent.js";
import { ProcessActivity } from "./ProcessActivity.js";
import { projectProcessActivity } from "./processActivityProjection.js";
import { ToolActivity } from "./ToolActivity.js";
import { isInvisibleAssistant } from "./toolDisplayRecords.js";

type SubagentRow = Extract<ChatItem, { kind: "subagent" }>;

/** The parent-feed row of one subagent: Desktop's agent card, opening its detail. */
export function SubagentRowButton({
  item,
  onOpen,
}: {
  item: SubagentRow;
  onOpen?: (agentId: string) => void;
}) {
  const meta = [
    subagentStatusLabel(item.status),
    item.toolCount ? `${item.toolCount} 次工具调用` : "",
  ].filter(Boolean);
  const preview = (item.error || item.text || "").replace(/\s+/g, " ").trim().slice(0, 160);
  const body = (
    <>
      <span className="subagent-row-title">↳ {item.label}</span>
      <span className="subagent-row-meta">{meta.join(" · ")}</span>
      {preview ? <span className="subagent-row-preview">{preview}</span> : null}
    </>
  );
  return onOpen ? (
    <button
      type="button"
      className="subagent-row"
      aria-label={`查看子代理 ${item.label}`}
      onClick={() => onOpen(item.agentId)}
    >
      {body}
    </button>
  ) : (
    <div className="subagent-row">{body}</div>
  );
}

/** Read-only items of one child transcript, with the same renderers as the chat. */
function TranscriptItems({
  items,
  running,
  scope,
  onOpenChild,
}: {
  items: readonly ChatItem[];
  running: boolean;
  scope: string;
  onOpenChild: (agentId: string) => void;
}) {
  return (
    <>
      {projectProcessActivity(items, { running }).map((item) => {
        switch (item.kind) {
          case "user":
            return (
              <div key={item.id} className="msg user">
                <span>{item.text}</span>
              </div>
            );
          case "answer":
            return (
              <div key={item.id} className="msg assistant">
                <AnswerContent items={item.items} partial={item.partial} pending={item.pending} />
              </div>
            );
          case "process":
            return (
              <div key={item.id} className="msg tool">
                <ProcessActivity group={item} detailScope={scope} />
              </div>
            );
          case "assistant":
            if (isInvisibleAssistant(item)) return null;
            return (
              <div key={item.id} className="msg assistant">
                <MessageContent
                  text={item.text}
                  reasoning={item.reasoning}
                  streaming={!item.done}
                  showCopy={false}
                />
              </div>
            );
          case "tool":
            return (
              <div key={item.id} className={`msg tool${item.error ? " tool-error" : ""}`}>
                <ToolActivity items={[item]} running={running} detailScope={scope} />
              </div>
            );
          case "subagent":
            return <SubagentRowButton key={item.id} item={item} onOpen={onOpenChild} />;
          case "system":
            return (
              <div key={item.id} className="msg info">
                {item.text}
              </div>
            );
          case "system_error":
            return (
              <div key={item.id} className="msg error">
                {item.text}
              </div>
            );
          default:
            return null;
        }
      })}
    </>
  );
}

function SubagentList({
  items,
  onSelect,
}: {
  items: readonly SubagentListItem[];
  onSelect: (id: string) => void;
}) {
  if (!items.length) return <p className="empty">这个对话还没有子代理。</p>;
  return (
    <div className="subagent-list" data-subagent-list>
      {SUBAGENT_GROUPS.map((group) => {
        const members = items.filter((item) => item.status === group.status);
        if (!members.length) return null;
        return (
          <section key={group.status} aria-label={group.label}>
            <h3>
              {group.label} · {members.length}
            </h3>
            <ul>
              {members.map((item) => (
                <li key={item.id}>
                  <button type="button" className="session" onClick={() => onSelect(item.id)}>
                    <span className="session-title">{item.title}</span>
                    {item.toolCount ? (
                      <span className="session-meta">{item.toolCount} 次工具调用</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** Desktop's subagent panel for the remote Workbench: list, child transcript, back. */
export function SubagentView({ app }: { app: RemoteApp }) {
  const subagents = app.subagents;
  const view = subagents?.view;
  if (!subagents || !view) return null;
  if (view.kind === "room") {
    const tool = roomAgentItems(app.chat.items).find((item) => item.id === view.toolId);
    return (
      <section className="subagent-view" aria-label="子代理详情">
        <header className="subagent-view-header">
          <button type="button" className="library-button" onClick={subagents.back}>
            返回
          </button>
          <strong>{tool?.summary || tool?.name || "子代理"}</strong>
        </header>
        <div className="subagent-view-body">
          {tool ? (
            <div className="msg tool">
              <ToolActivity items={[tool]} detailScope={`room:${view.roomId}`} />
            </div>
          ) : null}
          <p className="empty">
            外部 CLI 不保存子代理的完整过程，这里只能查看这次调用的请求和结果。
          </p>
        </div>
      </section>
    );
  }
  const list = subagentListItems(
    // Nested lists come from the Host catalog only.
    view.parentSessionId === app.activeSessionId ? app.chat.items : [],
    view.catalog,
  );
  const selected = view.selectedId ? list.find((item) => item.id === view.selectedId) : undefined;
  const running = selected?.status === "active" || view.transcript?.run === "running";
  return (
    <section
      className="subagent-view"
      aria-label={view.selectedId ? "子代理记录" : "子代理"}
      data-subagent-view={view.selectedId ? "detail" : "list"}
    >
      <header className="subagent-view-header">
        <button
          type="button"
          className="library-button"
          data-subagent-action={view.selectedId ? "back-to-list" : "back-to-parent"}
          onClick={subagents.back}
        >
          {view.selectedId ? "返回列表" : "返回对话"}
        </button>
        <strong>{view.selectedId ? selected?.title || view.selectedId : "子代理"}</strong>
        <button
          type="button"
          className="library-button"
          disabled={view.listLoading || view.transcriptLoading}
          onClick={subagents.refresh}
        >
          {view.listLoading || view.transcriptLoading ? "正在刷新…" : "刷新"}
        </button>
      </header>
      <div className="subagent-view-body">
        {view.selectedId ? (
          <>
            {view.transcriptError ? <p role="alert">{view.transcriptError}</p> : null}
            {view.transcript?.items.length ? (
              <TranscriptItems
                items={view.transcript.items}
                running={running}
                scope={`subagent:${view.selectedId}`}
                onOpenChild={subagents.select}
              />
            ) : (
              <p className="empty">
                {view.transcriptLoading ? "正在读取子代理记录…" : "这个子代理还没有记录。"}
              </p>
            )}
          </>
        ) : (
          <>
            {view.listError ? <p role="alert">{view.listError}</p> : null}
            {view.listLoading && !list.length ? (
              <p className="empty">正在读取子代理…</p>
            ) : (
              <SubagentList items={list} onSelect={subagents.select} />
            )}
          </>
        )}
      </div>
    </section>
  );
}

/** Workbench wiring: parent-row action, list entry and the open view. */
export function subagentControls(
  app: RemoteApp,
): Pick<WorkbenchController, "openSubagent" | "subagentEntry" | "subagentView"> {
  const subagents = app.subagents;
  if (!subagents) return {};
  const subagentView = subagents.view ? <SubagentView app={app} /> : undefined;
  const roomId = app.activeRoomId;
  if (roomId) {
    // CLI rooms keep no child transcript: Desktop opens the Agent/Task card.
    const calls = roomAgentItems(app.chat.items);
    return {
      subagentView,
      subagentEntry: calls.length ? (
        <details className="subagent-entry">
          <summary>子代理调用 · {calls.length}</summary>
          {calls.map((call) => (
            <button
              type="button"
              className="library-button"
              key={call.id}
              onClick={() => subagents.openRoomAgent(roomId, call.id)}
            >
              {call.summary || call.name}
            </button>
          ))}
        </details>
      ) : undefined,
    };
  }
  const sessionId = app.activeSessionId;
  if (!sessionId) return { subagentView };
  const count = subagentRows(app.chat.items).length;
  return {
    subagentView,
    openSubagent: (agentId) => subagents.open(sessionId, agentId),
    subagentEntry: count ? (
      <button
        type="button"
        className="library-button subagent-entry"
        onClick={() => subagents.open(sessionId)}
      >
        子代理 · {count}
      </button>
    ) : undefined,
  };
}
