import React from "react";
import type { GitPanelAppDiscoveryCandidate, GitPanelAppSourceInput } from "@cjhyy/code-shell-core";
import type {
  ManagedPanel,
  PanelCompatibility,
  PanelDiscovery,
  PanelReview,
  PanelSnapshot,
} from "../../server/src/panels/types.js";
import { api, ApiError } from "./auth.js";
import { apiUrl } from "./api-context.js";
import "./hub-panels.css";

const ROOT = "/api/v1/panels";
const OFFICIAL_REPOSITORY = "https://github.com/cjhyy/codeshell-panel-apps.git";
const permissionLabels: Record<string, string> = {
  "context.session": "读取当前对话信息",
  "context.workspace": "读取当前工作区信息",
  storage: "保存面板自己的数据",
  "external.open": "打开外部网页",
  "agent.submitPrompt": "向当前对话提交任务",
  "agent.task": "创建和管理 Agent 任务",
  "workspace.info": "查看工作区信息",
  "workspace.read": "读取工作区文件",
  "workspace.write": "修改工作区文件",
  "notifications.send": "发送通知",
  "audio.transcribe": "将音频转成文字",
  "credentials.cookies": "使用宿主授权的浏览器 Cookie",
  "automations.manage": "管理自动化任务",
  process: "在宿主运行命令和进程",
  media: "处理宿主上的音视频文件",
  "media.capture": "使用麦克风、摄像头或屏幕录制",
};

export interface HubPanelsProps {
  onAuthLost: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onChanged?: () => void;
  onOpen: (panel: ManagedPanel) => void;
  hostLabel?: string;
  configurationVersion?: number;
}

function panelTitle(title: { default: string; "zh-CN"?: string }) {
  return title["zh-CN"] || title.default;
}

function Compatibility({ value }: { value: PanelCompatibility }) {
  if (value.supported && value.reasons.length === 0) return null;
  return (
    <div className="panels-warning">
      <strong>{value.supported ? "部分功能可用" : "当前 Web 工作台暂不支持此面板"}</strong>
      {value.supported && <p>可以打开面板，以下功能当前不可用或需要额外配置。</p>}
      {value.reasons.length > 0 && (
        <ul>
          {value.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One management UI for the Hub and the Desktop's paired Web workbench. */
export function HubPanels({
  onAuthLost,
  onDirtyChange,
  onChanged,
  onOpen,
  hostLabel = "服务端",
  configurationVersion = 0,
}: HubPanelsProps) {
  const [snapshot, setSnapshot] = React.useState<PanelSnapshot>();
  const [url, setUrl] = React.useState("");
  const [ref, setRef] = React.useState("");
  const [subdir, setSubdir] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [discovery, setDiscovery] = React.useState<PanelDiscovery>();
  const [review, setReview] = React.useState<PanelReview>();
  const [reviewSource, setReviewSource] = React.useState<GitPanelAppSourceInput>();
  const [batch, setBatch] = React.useState<{
    candidates: GitPanelAppDiscoveryCandidate[];
    position: number;
  }>();
  const [reviewStale, setReviewStale] = React.useState(false);
  const [bindAfterInstall, setBindAfterInstall] = React.useState(true);
  const [preserveBinding, setPreserveBinding] = React.useState(false);
  const [removing, setRemoving] = React.useState<ManagedPanel>();
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState("");
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [reload, setReload] = React.useState(0);
  const mounted = React.useRef(false);
  const operation = React.useRef<AbortController | undefined>(undefined);
  const read = React.useRef<AbortController | undefined>(undefined);
  const queuedRefresh = React.useRef(false);
  const reviewHeading = React.useRef<HTMLHeadingElement>(null);
  const callbacks = React.useRef({ onAuthLost, onDirtyChange, onChanged, onOpen });
  callbacks.current = { onAuthLost, onDirtyChange, onChanged, onOpen };

  const dirty = !!(
    busy ||
    review ||
    batch ||
    removing ||
    url.trim() ||
    ref.trim() ||
    subdir.trim()
  );
  const report = React.useCallback((cause: unknown) => {
    if (cause instanceof ApiError && cause.status === 401) callbacks.current.onAuthLost();
    else setError(cause instanceof Error ? cause.message : "面板操作失败，请重试。");
  }, []);

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current?.abort();
      read.current?.abort();
      callbacks.current.onDirtyChange?.(false);
    };
  }, []);
  React.useEffect(() => {
    callbacks.current.onDirtyChange?.(dirty);
  }, [dirty]);
  React.useEffect(() => {
    if (operation.current) {
      queuedRefresh.current = true;
      return;
    }
    const controller = new AbortController();
    read.current = controller;
    setLoading(true);
    void api<PanelSnapshot>(apiUrl(ROOT), { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setSnapshot(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) report(cause);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reload, configurationVersion, report]);
  React.useEffect(() => {
    if (review) reviewHeading.current?.focus();
  }, [review?.reviewToken]);

  async function run<T>(
    label: string,
    path: string,
    method: string,
    body: Record<string, unknown>,
    mutation = false,
  ): Promise<T | undefined> {
    if (operation.current) return undefined;
    const controller = new AbortController();
    operation.current = controller;
    read.current?.abort();
    setLoading(false);
    setBusy(label);
    setError("");
    setNotice("");
    // Capture the authorized workspace before any asynchronous work starts.
    const target = apiUrl(`${ROOT}${path}`);
    try {
      const result = await api<T>(target, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (controller.signal.aborted || !mounted.current) return undefined;
      if (mutation) {
        queuedRefresh.current = true;
        callbacks.current.onChanged?.();
      }
      return result;
    } catch (cause) {
      if (controller.signal.aborted || !mounted.current) return undefined;
      if (cause instanceof ApiError && (cause.status === 409 || cause.status === 410)) {
        if (review) setReviewStale(true);
        queuedRefresh.current = true;
      }
      report(cause);
      return undefined;
    } finally {
      if (operation.current === controller) operation.current = undefined;
      if (mounted.current && !controller.signal.aborted) {
        setBusy("");
        if (queuedRefresh.current) {
          queuedRefresh.current = false;
          setReload((value) => value + 1);
        }
      }
    }
  }

  const discover = async (source: GitPanelAppSourceInput) => {
    setBatch(undefined);
    setReview(undefined);
    setRemoving(undefined);
    setDiscovery(undefined);
    const result = await run<PanelDiscovery>("正在读取仓库…", "/github/discover", "POST", {
      url: source.url,
      ...(source.ref ? { ref: source.ref } : {}),
      ...(source.subdir ? { subdir: source.subdir } : {}),
    });
    if (result) setDiscovery(result);
  };
  const previewSource = async (source: GitPanelAppSourceInput) => {
    const result = await run<PanelReview>("正在准备安装审阅…", "/preview", "POST", { source });
    if (result) {
      setRemoving(undefined);
      setReviewSource(source);
      setReview(result);
      setReviewStale(false);
      setPreserveBinding(false);
      setBindAfterInstall(!!snapshot?.hasProject && result.compatibility.supported);
    }
  };
  const previewUpdate = async (panel: ManagedPanel) => {
    const result = await run<PanelReview>(
      "正在检查更新…",
      `/${encodeURIComponent(panel.id)}/update-preview`,
      "POST",
      { expectedRevision: panel.revision },
    );
    if (result) {
      setRemoving(undefined);
      setReviewSource(undefined);
      setReview(result);
      setReviewStale(false);
      setPreserveBinding(panel.bound);
      setBindAfterInstall(panel.bound && result.compatibility.supported);
    }
  };
  const renewReview = () => {
    if (!review) return;
    if (review.kind === "update") {
      const current = snapshot?.panels.find((panel) => panel.id === review.preview.id);
      if (current) void previewUpdate(current);
      else {
        setError("此面板已被卸载，请重新从 GitHub 选择安装。");
        setReview(undefined);
      }
    } else if (reviewSource) void previewSource(reviewSource);
  };
  const clearImport = () => {
    setBatch(undefined);
    setDiscovery(undefined);
    setUrl("");
    setRef("");
    setSubdir("");
  };
  const advanceBatch = async () => {
    setReview(undefined);
    if (!batch || batch.position + 1 >= batch.candidates.length) {
      clearImport();
      return;
    }
    const position = batch.position + 1;
    setBatch({ ...batch, position });
    await previewSource(batch.candidates[position].source);
  };
  const startBatch = async (candidates: GitPanelAppDiscoveryCandidate[]) => {
    if (!candidates.length) return;
    setBatch({ candidates, position: 0 });
    await previewSource(candidates[0].source);
  };
  const install = async () => {
    if (!review || reviewStale) return;
    if (review.expiresAt <= Date.now()) {
      setReviewStale(true);
      setError("安装审阅已过期，请重新审阅后继续。");
      return;
    }
    const result = await run<{ id: string }>(
      review.kind === "update" ? "正在更新面板…" : "正在安装面板…",
      "/install",
      "POST",
      { reviewToken: review.reviewToken, bind: bindAfterInstall },
      true,
    );
    if (!result) return;
    setNotice(
      `${panelTitle(review.preview.title)} 已${review.kind === "update" ? "更新" : "安装"}${bindAfterInstall ? "并绑定当前工作区" : ""}。`,
    );
    setReview(undefined);
    if (batch) await advanceBatch();
    else clearImport();
  };
  const setBinding = async (panel: ManagedPanel) => {
    const result = await run<PanelSnapshot>(
      panel.bound ? "正在解除绑定…" : "正在绑定工作区…",
      `/${encodeURIComponent(panel.id)}/binding`,
      "PATCH",
      { bound: !panel.bound, expectedRevision: panel.revision },
      true,
    );
    if (result) {
      setSnapshot(result);
      setNotice(
        `${panelTitle(panel.title)} 已${panel.bound ? "解除当前工作区绑定" : "绑定当前工作区"}。`,
      );
    }
  };
  const uninstall = async () => {
    if (
      !removing ||
      snapshot?.panels.find((panel) => panel.id === removing.id)?.revision !== removing.revision
    )
      return;
    const result = await run<{ removed: boolean }>(
      "正在卸载面板…",
      `/${encodeURIComponent(removing.id)}`,
      "DELETE",
      { expectedRevision: removing.revision },
      true,
    );
    if (result?.removed) {
      setNotice(`${panelTitle(removing.title)} 已卸载。`);
      setRemoving(undefined);
    }
  };

  const unavailable = !!busy || !snapshot || !!batch;
  const needle = query.trim().toLowerCase();
  const rows = (snapshot?.panels ?? []).filter((panel) =>
    [panelTitle(panel.title), panel.id, panel.description ?? "", panel.source.label]
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
  const pendingCandidates =
    discovery?.panels.filter(
      (candidate) =>
        !snapshot?.panels.some((panel) => panel.id === candidate.id) &&
        discovery.panels.filter((other) => other.id === candidate.id).length === 1,
    ) ?? [];
  const latestRemoval = removing && snapshot?.panels.find((panel) => panel.id === removing.id);
  const removalStale = !!removing && latestRemoval?.revision !== removing.revision;
  const installedReview =
    review?.kind === "update"
      ? snapshot?.panels.find((panel) => panel.id === review.preview.id)
      : undefined;

  return (
    <section className="hub-panels">
      <header className="panels-heading">
        <div>
          <h1>面板</h1>
          <p>从 GitHub 安装工具面板，绑定工作区后直接在工作台中打开。</p>
        </div>
        <button disabled={!!busy || loading} onClick={() => setReload((value) => value + 1)}>
          {loading ? "正在刷新…" : "刷新"}
        </button>
      </header>
      <p className="panels-muted">面板安装在{hostLabel}上，文件和任务操作使用当前工作区。</p>
      {snapshot && !snapshot.hasProject && (
        <div className="panels-warning">请先选择一个项目，才能绑定和打开面板。</div>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="panels-notice">
          {notice}
        </p>
      )}
      {busy && (
        <p role="status" className="panels-muted">
          {busy}
        </p>
      )}

      {batch && (
        <section className="panels-confirm" aria-label="逐个审阅面板">
          <p>
            正在审阅第 {batch.position + 1} / {batch.candidates.length} 个面板：
            {panelTitle(batch.candidates[batch.position].title)}。每个面板都需要单独确认安装。
          </p>
          <div className="panels-actions">
            {!review && (
              <button
                disabled={!!busy}
                onClick={() => void previewSource(batch.candidates[batch.position].source)}
              >
                重新读取此面板
              </button>
            )}
            <button disabled={!!busy} onClick={() => void advanceBatch()}>
              跳过此面板
            </button>
            <button
              disabled={!!busy}
              onClick={() => {
                setBatch(undefined);
                setReview(undefined);
                setError("");
              }}
            >
              取消逐个审阅
            </button>
          </div>
        </section>
      )}

      {review && (
        <section className="panels-review" aria-labelledby="panel-review-heading">
          <header className="panels-heading">
            <div>
              <h2 id="panel-review-heading" ref={reviewHeading} tabIndex={-1}>
                {review.kind === "update" ? "审阅面板更新" : "审阅面板安装"}
              </h2>
              <p>
                {panelTitle(review.preview.title)} · {review.preview.id} · v{review.preview.version}
              </p>
            </div>
            <button
              disabled={!!busy}
              onClick={() => {
                setBatch(undefined);
                setReview(undefined);
                setError("");
              }}
            >
              取消审阅
            </button>
          </header>
          {review.preview.description && <p>{review.preview.description}</p>}
          {installedReview && (
            <p className="panels-warning">
              当前版本 v{installedReview.version} → 更新后 v{review.preview.version}
              {installedReview.source.commit && (
                <>
                  <br />
                  当前提交 <code>{installedReview.source.commit.slice(0, 12)}</code> → 更新提交{" "}
                  <code>{review.source.commit.slice(0, 12)}</code>
                </>
              )}
            </p>
          )}
          <section>
            <h3>安装来源</h3>
            <dl>
              <dt>仓库</dt>
              <dd>{review.source.url}</dd>
              <dt>分支 / 标签</dt>
              <dd>{review.source.ref}</dd>
              <dt>已锁定提交</dt>
              <dd>
                <code>{review.source.commit}</code>
              </dd>
              <dt>面板目录</dt>
              <dd>{review.source.subdir || "仓库根目录"}</dd>
              <dt>界面入口</dt>
              <dd>
                <code>{review.preview.entry}</code>
              </dd>
            </dl>
          </section>
          <section>
            <h3>面板请求的权限</h3>
            {review.preview.permissions.length === 0 ? (
              <p className="panels-muted">未申请宿主权限。</p>
            ) : (
              review.preview.permissions.map((permission) => (
                <div className="panels-permission" key={permission}>
                  <span>{permissionLabels[permission] ?? permission}</span>
                  <small>{permission}</small>
                </div>
              ))
            )}
          </section>
          <section>
            <h3>随面板安装的工具与 Skills</h3>
            {!(review.preview.agent?.tools.length || review.preview.agent?.skills.length) ? (
              <p className="panels-muted">此面板没有额外的 Agent 工具或 Skills。</p>
            ) : (
              <div className="panels-badges">
                {review.preview.agent?.tools.map((tool) => (
                  <span key={tool.name} className="panels-badge" title={tool.description}>
                    {tool.name} · {tool.readOnly ? "只读" : "可修改数据"}
                  </span>
                ))}
                {review.preview.agent?.skills.map((skill) => (
                  <span key={skill} className="panels-badge">
                    Skill · {skill.split("/").at(-2) ?? skill}
                  </span>
                ))}
              </div>
            )}
          </section>
          <Compatibility value={review.compatibility} />
          {review.preview.warnings.length > 0 && (
            <div className="panels-warning">
              <ul>
                {review.preview.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}
          <footer>
            {!review.compatibility.supported && (
              <p className="panels-muted">
                可以安装到{hostLabel}，但当前 Web 工作台无法绑定或打开它。
              </p>
            )}
            {preserveBinding ? (
              <p className="panels-muted">已绑定当前工作区，更新将保留绑定。</p>
            ) : (
              <label className="panels-check">
                <input
                  type="checkbox"
                  checked={bindAfterInstall}
                  disabled={!!busy || !snapshot?.hasProject || !review.compatibility.supported}
                  onChange={(event) => setBindAfterInstall(event.target.checked)}
                />
                绑定当前工作区
              </label>
            )}
            {reviewStale ? (
              <div className="panels-actions">
                <span className="panels-muted">安装内容或本地版本已变化，请重新审阅。</span>
                <button disabled={!!busy} onClick={renewReview}>
                  重新审阅
                </button>
              </div>
            ) : (
              <button className="panels-primary" disabled={!!busy} onClick={() => void install()}>
                {review.kind === "update" ? "确认更新" : "确认安装"}
              </button>
            )}
          </footer>
        </section>
      )}

      <section className="panels-section" aria-labelledby="installed-panels-heading">
        <div className="panels-heading">
          <h2 id="installed-panels-heading">
            已安装面板{snapshot ? ` · ${snapshot.panels.length}` : ""}
          </h2>
          <input
            type="search"
            aria-label="搜索已安装面板"
            placeholder="搜索已安装面板"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {!snapshot && (
          <p className="panels-muted">
            {loading ? "正在读取面板…" : "暂时无法读取面板，请刷新重试。"}
          </p>
        )}
        {snapshot && rows.length === 0 && (
          <div className="panels-empty">
            <strong>{snapshot.panels.length ? "没有匹配的面板" : "还没有安装面板"}</strong>
            <p className="panels-muted">
              {snapshot.panels.length
                ? "试试其他名称或清除搜索。"
                : "在下方粘贴 GitHub 仓库地址，或浏览官方面板仓库。"}
            </p>
          </div>
        )}
        <div className="panels-grid">
          {rows.map((panel) => (
            <article className="panels-card" key={panel.id}>
              <div className="panels-card-heading">
                <h3>{panelTitle(panel.title)}</h3>
                <span className="panels-badge">v{panel.version}</span>
              </div>
              <small>{panel.id}</small>
              {panel.description && <p>{panel.description}</p>}
              <div className="panels-badges">
                <span
                  className={`panels-badge ${panel.enabled && panel.compatibility.supported ? "panels-badge-ready" : ""}`}
                >
                  {panel.globalDisabled
                    ? "已全局停用"
                    : panel.bound
                      ? "已绑定当前工作区"
                      : "未绑定当前工作区"}
                </span>
              </div>
              <dl>
                <dt>来源</dt>
                <dd>{panel.source.label}</dd>
                {panel.source.ref && (
                  <>
                    <dt>分支 / 标签</dt>
                    <dd>{panel.source.ref}</dd>
                  </>
                )}
              </dl>
              <Compatibility value={panel.compatibility} />
              {panel.globalDisabled && (
                <p className="panels-muted">请在宿主配置中启用此面板后使用。</p>
              )}
              <div className="panels-actions">
                <button
                  className="panels-primary"
                  disabled={unavailable || !panel.enabled || !panel.compatibility.supported}
                  onClick={() => callbacks.current.onOpen(panel)}
                >
                  打开面板
                </button>
                <button
                  disabled={
                    unavailable ||
                    !snapshot?.hasProject ||
                    (!panel.bound && (panel.globalDisabled || !panel.compatibility.supported))
                  }
                  onClick={() => void setBinding(panel)}
                >
                  {panel.bound ? "解除绑定" : "绑定工作区"}
                </button>
                {panel.updatable && (
                  <button disabled={unavailable} onClick={() => void previewUpdate(panel)}>
                    检查更新
                  </button>
                )}
                <button
                  className="panels-danger"
                  disabled={unavailable}
                  onClick={() => {
                    setRemoving(panel);
                    setReview(undefined);
                    setError("");
                    setNotice("");
                  }}
                >
                  卸载
                </button>
              </div>
            </article>
          ))}
        </div>
        {removing && (
          <section className="panels-confirm" aria-label="确认卸载面板">
            <p>
              卸载「{panelTitle(removing.title)}」v{removing.version}？面板将从{hostLabel}
              移除，其他工作区也将无法打开它。
            </p>
            <div className="panels-actions">
              <button disabled={!!busy} onClick={() => setRemoving(undefined)}>
                取消卸载
              </button>
              {removalStale && (
                <span className="panels-muted">
                  {latestRemoval
                    ? "面板已被其他设备修改，请查看最新版本后重新确认。"
                    : "此面板已被其他设备卸载。"}
                </span>
              )}
              {removalStale && latestRemoval && (
                <button
                  disabled={!!busy || loading}
                  onClick={() => {
                    setRemoving(latestRemoval);
                    setError("");
                  }}
                >
                  查看最新版本
                </button>
              )}
              <button
                className="panels-danger"
                disabled={!!busy || loading || removalStale}
                onClick={() => void uninstall()}
              >
                确认卸载
              </button>
            </div>
          </section>
        )}
      </section>

      <section className="panels-import panels-section" aria-labelledby="github-panels-heading">
        <div className="panels-heading">
          <div>
            <h2 id="github-panels-heading">从 GitHub 安装</h2>
            <p>先读取仓库并选择面板，再查看安装内容和所需权限。</p>
          </div>
          <button
            disabled={unavailable}
            onClick={() => {
              setUrl(OFFICIAL_REPOSITORY);
              setRef("");
              setSubdir("");
              void discover({ kind: "git", url: OFFICIAL_REPOSITORY });
            }}
          >
            浏览官方仓库
          </button>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!url.trim()) return;
            void discover({
              kind: "git",
              url: url.trim(),
              ...(ref.trim() ? { ref: ref.trim() } : {}),
              ...(subdir.trim() ? { subdir: subdir.trim() } : {}),
            });
          }}
        >
          <label>
            GitHub 仓库地址
            <input
              type="url"
              placeholder="https://github.com/owner/repository"
              value={url}
              required
              disabled={!!busy || !!batch}
              onChange={(event) => {
                setUrl(event.target.value);
                setDiscovery(undefined);
              }}
            />
          </label>
          <details>
            <summary>指定分支或子目录</summary>
            <div className="panels-source-fields">
              <label>
                分支 / 标签（可选）
                <input
                  value={ref}
                  placeholder="使用默认分支"
                  disabled={!!busy || !!batch}
                  onChange={(event) => {
                    setRef(event.target.value);
                    setDiscovery(undefined);
                  }}
                />
              </label>
              <label>
                子目录（可选）
                <input
                  value={subdir}
                  placeholder="例如 apps/my-panel"
                  disabled={!!busy || !!batch}
                  onChange={(event) => {
                    setSubdir(event.target.value);
                    setDiscovery(undefined);
                  }}
                />
              </label>
            </div>
          </details>
          <div className="panels-actions">
            <button type="submit" disabled={unavailable || !url.trim()}>
              读取仓库
            </button>
            {(url || ref || subdir || discovery) && (
              <button
                type="button"
                disabled={!!busy}
                onClick={() => {
                  clearImport();
                  setReview(undefined);
                }}
              >
                清除
              </button>
            )}
          </div>
        </form>
        {discovery && (
          <div className="panels-candidates">
            <h3>找到 {discovery.panels.length} 个面板</h3>
            <p className="panels-muted">
              {discovery.source.url} · {discovery.source.ref} ·{" "}
              <code>{discovery.source.commit.slice(0, 12)}</code>
            </p>
            {discovery.panels.length === 0 && (
              <p className="panels-muted">仓库中没有找到可安装的面板。请检查地址和子目录。</p>
            )}
            {pendingCandidates.length > 1 && (
              <div className="panels-actions panels-batch-start">
                <button disabled={unavailable} onClick={() => void startBatch(pendingCandidates)}>
                  逐个审阅未安装面板（{pendingCandidates.length}）
                </button>
                <small>按顺序确认，可随时跳过或停止。</small>
              </div>
            )}
            <div className="panels-grid">
              {discovery.panels.map((candidate) => {
                const existing = snapshot?.panels.find((panel) => panel.id === candidate.id);
                return (
                  <article className="panels-card" key={`${candidate.id}:${candidate.subdir}`}>
                    <div className="panels-card-heading">
                      <h3>{panelTitle(candidate.title)}</h3>
                      <span className="panels-badge">v{candidate.version}</span>
                    </div>
                    {candidate.description && <p>{candidate.description}</p>}
                    <small>{candidate.subdir === "." ? "仓库根目录" : candidate.subdir}</small>
                    <div className="panels-actions">
                      <button
                        disabled={unavailable || !!(existing && !existing.updatable)}
                        onClick={() =>
                          existing
                            ? void previewUpdate(existing)
                            : void previewSource(candidate.source)
                        }
                      >
                        {existing
                          ? existing.updatable
                            ? "已安装 · 检查更新"
                            : "已从其他来源安装"
                          : "审阅安装"}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
            {discovery.issues.length > 0 && (
              <div className="panels-warning">
                <strong>部分目录无法作为面板安装</strong>
                <ul>
                  {discovery.issues.map((issue) => (
                    <li key={issue.subdir}>
                      {issue.subdir}：{issue.error}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>
    </section>
  );
}
