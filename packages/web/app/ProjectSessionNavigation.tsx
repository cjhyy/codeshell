import React from "react";
import type { MobileProjectMeta } from "@cjhyy/code-shell-core";
import { groupByProject } from "../src/lib/format.js";
import type { SessionSummary } from "./protocol.js";

const GROUP_BATCH = 8;
const SESSION_BATCH = 5;

/** The catalog stays mounted while the selected conversation loads. Render
 * bounded batches of already fetched rows; fetching another page is explicit. */
export function ProjectSessionNavigation({
  sessions,
  projects,
  activeId,
  loading,
  hasMore,
  loadMore,
  renderSession,
  filtered,
  onNewSession,
}: {
  sessions: SessionSummary[];
  projects: readonly MobileProjectMeta[];
  activeId: string;
  loading?: boolean;
  hasMore?: boolean;
  loadMore?: () => void;
  renderSession: (session: SessionSummary) => React.ReactNode;
  /** Rows were narrowed by search or lifted into 置顶, so "no sessions yet" would mislead. */
  filtered?: boolean;
  /** Start a conversation in a group's project (id or path); null = no project. */
  onNewSession?: (projectIdOrCwd: string | null, cwd: string | null) => void;
}) {
  const [groupLimit, setGroupLimit] = React.useState(GROUP_BATCH);
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(() => new Set());
  const [limits, setLimits] = React.useState<Record<string, number>>({});
  const groups = React.useMemo(
    () =>
      groupByProject(
        sessions.map((item) => ({
          ...item,
          originalSession: item,
          cwd: item.cwd ?? "",
          updatedAt: item.lastActiveAt ?? item.startedAt,
        })),
        [...projects],
        "zh",
      ),
    [sessions, projects],
  );
  const visible = groups.slice(0, groupLimit);
  // Keep an externally selected conversation reachable without expanding
  // every intervening group or mounting its entire history catalog.
  const selected = groups.find((group) => group.items.some((row) => row.sessionId === activeId));
  if (selected && !visible.includes(selected)) visible.push(selected);

  return (
    <section
      className="project-session-navigation"
      aria-label="项目会话"
      aria-busy={loading || undefined}
    >
      <div className="rail-section-label history-label">
        <span>项目</span>
        <span>{loading ? "正在更新…" : `已加载 ${sessions.length}`}</span>
      </div>
      {!groups.length && !(filtered && !loading) ? (
        <p className="project-session-empty" role={loading ? "status" : undefined}>
          {loading ? "正在读取会话目录…" : "还没有会话，可以直接开始无项目对话。"}
        </p>
      ) : null}
      {visible.map((group) => {
        const key = group.projectId ? `project:${group.projectId}` : `cwd:${group.cwd}`;
        const closed = collapsed.has(key);
        const limit = limits[key] ?? SESSION_BATCH;
        const rows = group.items.slice(0, limit);
        const active = group.items.find((row) => row.sessionId === activeId);
        if (active && !rows.includes(active)) rows.push(active);
        return (
          <div className="project-session-group" key={key}>
            <div className="project-session-heading-row">
              <button
                type="button"
                className="project-session-heading"
                title={group.cwd || "无项目对话"}
                aria-label={`${closed ? "展开" : "折叠"} ${group.name}`}
                aria-expanded={!closed}
                onClick={() =>
                  setCollapsed((previous) => {
                    const next = new Set(previous);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  })
                }
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
                </svg>
                <span>{group.name}</span>
                <span className="project-session-count">{group.items.length}</span>
                <span className="project-session-chevron" aria-hidden="true">
                  {closed ? "›" : "⌄"}
                </span>
              </button>
              {onNewSession ? (
                <button
                  type="button"
                  className="project-session-new"
                  aria-label={`在 ${group.name} 中新建对话`}
                  title={`在 ${group.name} 中新建对话`}
                  onClick={() =>
                    onNewSession(
                      group.cwd ? (group.projectId ?? group.cwd) : null,
                      group.cwd || null,
                    )
                  }
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    aria-hidden="true"
                  >
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                  </svg>
                </button>
              ) : null}
            </div>
            {!closed ? (
              <>
                <ul className="sessions project-session-rows" aria-label={`${group.name}的会话`}>
                  {rows.map((row) => renderSession(row.originalSession))}
                </ul>
                {rows.length < group.items.length ? (
                  <button
                    type="button"
                    className="project-session-more"
                    onClick={() =>
                      setLimits((previous) => ({ ...previous, [key]: limit + SESSION_BATCH }))
                    }
                  >
                    展开显示更多（{group.items.length - rows.length}）
                  </button>
                ) : null}
                {limit > SESSION_BATCH ? (
                  <button
                    type="button"
                    className="project-session-more"
                    onClick={() => setLimits((previous) => ({ ...previous, [key]: SESSION_BATCH }))}
                  >
                    收起更多会话
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
        );
      })}
      {visible.length < groups.length ? (
        <button
          type="button"
          className="project-session-more"
          onClick={() => setGroupLimit((previous) => previous + GROUP_BATCH)}
        >
          显示更多项目（{groups.length - visible.length}）
        </button>
      ) : null}
      {hasMore && loadMore ? (
        <button
          type="button"
          className="project-session-more"
          disabled={loading}
          onClick={loadMore}
        >
          {loading ? "正在加载更多会话…" : "加载更多会话"}
        </button>
      ) : null}
    </section>
  );
}
