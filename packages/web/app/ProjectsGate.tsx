import { EnvironmentMenu } from "./EnvironmentMenu.js";
import React from "react";
import { api, ApiError } from "./auth.js";
import { setApiProject, setApiWorkspace, validProjectId } from "./api-context.js";
import { WebsiteSetupSteps } from "./WebsiteSetupSteps.js";
import "./projects.css";

export interface RuntimeProject {
  id: string;
  name: string;
  status: "stopped" | "starting" | "running" | "stopping" | "error";
  generation: number;
  createdAt: number;
  error?: string;
}

interface ProjectSnapshot {
  runtime: "docker";
  projects: RuntimeProject[];
  available: boolean;
  error?: string;
}

function validProject(value: unknown): value is RuntimeProject {
  if (!value || typeof value !== "object") return false;
  const item = value as RuntimeProject;
  return (
    validProjectId(item.id) &&
    typeof item.name === "string" &&
    item.name.length > 0 &&
    ["stopped", "starting", "running", "stopping", "error"].includes(item.status) &&
    Number.isSafeInteger(item.generation) &&
    item.generation >= 0 &&
    Number.isSafeInteger(item.createdAt) &&
    item.createdAt >= 0 &&
    (item.error === undefined || typeof item.error === "string")
  );
}

function parseSnapshot(value: unknown): ProjectSnapshot {
  const snapshot = value as ProjectSnapshot | undefined;
  if (
    !snapshot ||
    snapshot.runtime !== "docker" ||
    typeof snapshot.available !== "boolean" ||
    !Array.isArray(snapshot.projects) ||
    !snapshot.projects.every(validProject) ||
    new Set(snapshot.projects.map((item) => item.id)).size !== snapshot.projects.length ||
    (snapshot.error !== undefined && typeof snapshot.error !== "string")
  )
    throw new Error("服务端返回了无效的项目列表，请重试。");
  return snapshot;
}

function selectedProject(): string | null {
  return new URL(window.location.href).searchParams.get("project");
}

function selectionUrl(id: string | null, keepSession = false): void {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("project", id);
  else url.searchParams.delete("project");
  if (!keepSession) url.searchParams.delete("session");
  window.history.replaceState(window.history.state, "", url);
}

const labels: Record<RuntimeProject["status"], string> = {
  stopped: "已停止",
  starting: "正在启动",
  running: "运行中",
  stopping: "正在停止",
  error: "启动失败",
};

/** Authentication belongs to the control plane; each child owns one runtime. */
export function ProjectsGate({
  children,
  onAuthLost,
  accountControl,
  allowLegacy = true,
  autoEnterSingle = false,
  startCreatedProject = false,
  canRequest,
}: {
  children: (project: RuntimeProject | null, onBack?: () => void) => React.ReactNode;
  onAuthLost: () => void;
  accountControl?: React.ReactNode;
  allowLegacy?: boolean;
  autoEnterSingle?: boolean;
  startCreatedProject?: boolean;
  canRequest?: () => boolean;
}) {
  const [snapshot, setSnapshot] = React.useState<ProjectSnapshot | null>(null);
  const [legacy, setLegacy] = React.useState(false);
  const [active, setActive] = React.useState<RuntimeProject | null>(null);
  const [error, setError] = React.useState("");
  const [checking, setChecking] = React.useState(true);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [startingCreated, setStartingCreated] = React.useState(false);
  const [name, setName] = React.useState("");
  const [stopTarget, setStopTarget] = React.useState<RuntimeProject | null>(null);
  const stopDialog = React.useRef<HTMLDialogElement>(null);
  const desired = React.useRef(selectedProject());
  const activeRef = React.useRef(active);
  const snapshotRef = React.useRef(snapshot);
  const lifecycle = React.useRef(0);
  const refreshRevision = React.useRef(0);
  const mutation = React.useRef<AbortController | null>(null);
  const authLost = React.useRef(onAuthLost);
  const legacyRef = React.useRef(false);
  const autoSelection = React.useRef(true);
  const requestAllowed = React.useRef(canRequest);
  requestAllowed.current = canRequest;
  authLost.current = onAuthLost;
  activeRef.current = active;
  snapshotRef.current = snapshot;

  const enter = React.useCallback((item: RuntimeProject) => {
    if (item.status !== "running") return;
    const keepSession = selectedProject() === item.id;
    setApiWorkspace(undefined);
    setApiProject(item.id);
    selectionUrl(item.id, keepSession);
    desired.current = null;
    autoSelection.current = false;
    activeRef.current = item;
    setActive(item);
    setError("");
  }, []);

  const back = React.useCallback(() => {
    desired.current = null;
    activeRef.current = null;
    setActive(null);
    setApiProject(null);
    setApiWorkspace(undefined);
    selectionUrl(null);
  }, []);

  const refresh = React.useCallback(
    async (signal?: AbortSignal) => {
      if (legacyRef.current) return;
      if (requestAllowed.current && !requestAllowed.current()) return;
      const revision = ++refreshRevision.current;
      const currentLifecycle = lifecycle.current;
      try {
        const next = parseSnapshot(await api<unknown>("/api/v1/projects", { signal }));
        if (
          signal?.aborted ||
          revision !== refreshRevision.current ||
          currentLifecycle !== lifecycle.current
        )
          return;
        setSnapshot(next);
        snapshotRef.current = next;
        setChecking(false);
        setError("");
        const current = activeRef.current;
        if (current) {
          const latest = next.projects.find((item) => item.id === current.id);
          if (!latest || latest.status !== "running" || latest.generation !== current.generation) {
            back();
            setError("项目运行状态已经变化，请重新打开项目。未发送的内容不会带入其他项目。");
          }
          return;
        }
        if (!desired.current) {
          if (
            autoEnterSingle &&
            autoSelection.current &&
            next.available &&
            next.projects.length === 1 &&
            next.projects[0]!.status === "running"
          )
            enter(next.projects[0]!);
          return;
        }
        const candidate = next.projects.find((item) => item.id === desired.current);
        if (!candidate) {
          autoSelection.current = false;
          desired.current = null;
          selectionUrl(null);
          setError("链接中的项目不存在或当前账号无权访问，请选择一个项目。");
        } else if (candidate.status === "running" && next.available) {
          enter(candidate);
        }
      } catch (cause) {
        if (
          signal?.aborted ||
          revision !== refreshRevision.current ||
          currentLifecycle !== lifecycle.current
        )
          return;
        setChecking(false);
        // Only an explicit 404 on the initial capability check enables legacy Hub.
        if (
          allowLegacy &&
          cause instanceof ApiError &&
          cause.status === 404 &&
          !snapshotRef.current
        ) {
          setApiProject(null);
          setApiWorkspace(undefined);
          legacyRef.current = true;
          setLegacy(true);
        } else if (cause instanceof ApiError && cause.status === 401) {
          authLost.current();
        } else {
          setError(cause instanceof Error ? cause.message : "无法读取项目，请重试。");
        }
      }
    },
    [back, enter, allowLegacy, autoEnterSingle],
  );

  React.useEffect(() => {
    lifecycle.current++;
    const controller = new AbortController();
    void refresh(controller.signal);
    const focus = () => void refresh(controller.signal);
    const visible = () => {
      if (document.visibilityState === "visible") focus();
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visible);
    return () => {
      lifecycle.current++;
      controller.abort();
      mutation.current?.abort();
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visible);
      setApiProject(null);
      setApiWorkspace(undefined);
    };
  }, [refresh]);

  const transitioning = snapshot?.projects.some(
    (item) => item.status === "starting" || item.status === "stopping",
  );
  React.useEffect(() => {
    if (legacy || !snapshot) return;
    const controller = new AbortController();
    const timer = setInterval(
      () => void refresh(controller.signal),
      transitioning ? 2_000 : 10_000,
    );
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [legacy, !!snapshot, transitioning, refresh]);

  React.useEffect(() => {
    if (!stopTarget) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = stopDialog.current;
    dialog?.showModal?.();
    return () => {
      dialog?.close?.();
      previous?.focus();
    };
  }, [stopTarget]);

  const change = async (operation: "create" | "start" | "stop", item?: RuntimeProject) => {
    if (requestAllowed.current && !requestAllowed.current()) return;
    if (mutation.current || (operation === "create" && !name.trim())) return;
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(item?.id ?? "create");
    setError("");
    refreshRevision.current++;
    let created = false;
    try {
      const value = await api<{ project: RuntimeProject }>(
        operation === "create" ? "/api/v1/projects" : `/api/v1/projects/${item!.id}/${operation}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(operation === "create" ? { name: name.trim() } : {}),
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted) return;
      if (!validProject(value.project) || (item && item.id !== value.project.id))
        throw new Error("服务端返回了无效的项目状态，请刷新列表。");
      let next = value.project;
      if (operation === "create" && startCreatedProject) {
        // Creation and startup are separate operations. Keep the created
        // workspace visible even when startup fails, so retry cannot duplicate it.
        created = true;
        const createdProject = next;
        setSnapshot((previous) =>
          previous
            ? {
                ...previous,
                projects: [
                  ...previous.projects.filter((entry) => entry.id !== createdProject.id),
                  createdProject,
                ],
              }
            : previous,
        );
        setName("");
        setStartingCreated(true);
        const started = await api<{ project: RuntimeProject }>(
          `/api/v1/projects/${next.id}/start`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
            signal: controller.signal,
          },
        );
        if (controller.signal.aborted) return;
        if (!validProject(started.project) || started.project.id !== next.id)
          throw new Error("服务端返回了无效的项目状态，请刷新列表。");
        next = started.project;
        desired.current = next.id;
        selectionUrl(next.id);
        if (next.status === "running") enter(next);
      }
      setSnapshot((previous) =>
        previous
          ? {
              ...previous,
              projects: previous.projects.some((entry) => entry.id === next.id)
                ? previous.projects.map((entry) => (entry.id === next.id ? next : entry))
                : [...previous.projects, next],
            }
          : previous,
      );
      if (operation === "create") setName("");
      if (operation === "start") {
        desired.current = next.id;
        selectionUrl(next.id);
        if (next.status === "running") enter(next);
      }
      if (operation === "stop") {
        if (desired.current === next.id) {
          desired.current = null;
          selectionUrl(null);
        }
        setStopTarget(null);
      }
      await refresh(controller.signal);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && cause.status === 401) authLost.current();
      else
        setError(
          (created ? "工作区已创建，启动尚未完成。请在下方点击“启动并打开”重试。" : "") +
            (cause instanceof Error ? cause.message : "项目操作失败，请重试。"),
        );
    } finally {
      if (mutation.current === controller) mutation.current = null;
      if (!controller.signal.aborted) {
        setBusy(null);
        setStartingCreated(false);
      }
    }
  };

  if (legacy) return <React.Fragment key="single-project">{children(null)}</React.Fragment>;
  if (active)
    return (
      <React.Fragment key={`${active.id}:${active.generation}`}>
        {error ? (
          <div className="project-connection-note" role="status">
            项目状态暂时无法刷新，当前工作台会保留。{error}
          </div>
        ) : null}
        {children(active, back)}
      </React.Fragment>
    );

  const firstWorkspace = startCreatedProject && snapshot?.projects.length === 0;
  return (
    <main className={`projects-page${firstWorkspace ? " projects-first-workspace" : ""}`}>
      <header className="projects-header">
        <div className="auth-brand">
          CodeShell <span>{accountControl ? "Cloud" : "Hub"}</span>
        </div>
        <EnvironmentMenu />
        {accountControl}
        <h1>{firstWorkspace ? "为第一个想法，建一个工作区" : "你的项目"}</h1>
        <p>
          {firstWorkspace
            ? "账号已就绪。给工作区起个名字，我们会为你准备好独立的文件、对话和运行环境。"
            : "每个项目有独立的运行环境、文件、会话和配置。打开后继续你的工作。"}
        </p>
        {firstWorkspace ? <WebsiteSetupSteps current={2} /> : null}
      </header>
      {checking ? <p role="status">正在读取项目…</p> : null}
      {error ? (
        <div className="form-error" role="alert">
          {error}
          <button className="library-button" onClick={() => void refresh()}>
            刷新项目
          </button>
        </div>
      ) : null}
      {snapshot ? (
        <>
          {!snapshot.available ? (
            <div className="form-error" role="alert">
              {startCreatedProject ? (
                "云端执行环境暂时不可用，请稍后重试或联系管理员。"
              ) : (
                <>项目运行环境暂不可用。{snapshot.error || "请检查服务端 Docker 是否已启动。"}</>
              )}
              <button className="library-button" disabled={!!busy} onClick={() => void refresh()}>
                重试连接运行环境
              </button>
            </div>
          ) : null}
          <section
            className={firstWorkspace ? "project-first-create" : undefined}
            aria-label={firstWorkspace ? "创建第一个工作区" : "创建项目"}
          >
            {firstWorkspace ? (
              <div className="project-first-heading">
                <span className="project-first-icon" aria-hidden="true">
                  ＋
                </span>
                <div>
                  <h2>从一个小目标开始</h2>
                  <p>例如整理学习资料、规划一个产品，或完成一项日常任务。</p>
                </div>
              </div>
            ) : null}
            <form
              className="project-create"
              onSubmit={(event) => {
                event.preventDefault();
                void change("create");
              }}
            >
              <label>
                {firstWorkspace ? "工作区名称" : "新项目名称"}
                <input
                  disabled={!!busy}
                  value={name}
                  maxLength={80}
                  required
                  placeholder={firstWorkspace ? "例如：我的第一个工作区" : "例如：个人网站"}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <button
                className="library-button primary"
                disabled={!!busy || !name.trim() || (startCreatedProject && !snapshot.available)}
                type="submit"
              >
                {busy === "create"
                  ? startingCreated
                    ? "正在启动…"
                    : "正在创建…"
                  : startCreatedProject
                    ? "创建并打开"
                    : "创建项目"}
              </button>
            </form>
            {firstWorkspace ? (
              <p className="project-first-next">
                下一步：连接你选择的模型，然后开始第一段对话。模型服务和 API Key 由你自行提供。
              </p>
            ) : null}
          </section>
          {busy === "create" ? (
            <p className="project-progress" role="status">
              {startingCreated
                ? "工作区已创建，正在准备运行环境。完成后将自动打开工作台…"
                : "正在创建工作区，请稍候…"}
            </p>
          ) : null}
          <section className="projects-grid" aria-label="项目列表">
            {snapshot.projects.length === 0 && !firstWorkspace ? (
              <p className="project-empty">创建第一个项目，开始配置模型、添加技能和使用面板。</p>
            ) : null}
            {snapshot.projects.map((item) => (
              <article className="project-card" key={item.id}>
                <div className="project-card-heading">
                  <h2>{item.name}</h2>
                  <span className={`project-status ${item.status}`}>{labels[item.status]}</span>
                </div>
                <p className="project-date">
                  创建于 {new Date(item.createdAt).toLocaleDateString()}
                </p>
                {item.error ? (
                  <p className="form-error" role="alert">
                    {item.error}
                  </p>
                ) : null}
                <div className="library-actions">
                  <button
                    className="library-button primary"
                    disabled={
                      !!busy ||
                      !snapshot.available ||
                      item.status === "starting" ||
                      item.status === "stopping"
                    }
                    onClick={() =>
                      item.status === "running" ? enter(item) : void change("start", item)
                    }
                  >
                    {busy === item.id || item.status === "starting" || item.status === "stopping"
                      ? "正在处理…"
                      : item.status === "running"
                        ? "打开项目"
                        : "启动并打开"}
                  </button>
                  {item.status === "running" ? (
                    <button
                      className="library-button"
                      disabled={!!busy}
                      onClick={() => setStopTarget(item)}
                    >
                      停止项目
                    </button>
                  ) : null}
                </div>
              </article>
            ))}
          </section>
        </>
      ) : null}
      {stopTarget ? (
        <dialog
          className="project-stop-confirm"
          ref={stopDialog}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="project-stop-title"
          onCancel={(event) => {
            event.preventDefault();
            if (!busy) setStopTarget(null);
          }}
        >
          <h2 id="project-stop-title">停止 {stopTarget.name}？</h2>
          <p>正在运行的任务和面板进程会中断。项目文件和配置保留，可稍后重新启动。</p>
          <div className="library-actions">
            <button
              className="library-button primary"
              disabled={!!busy}
              onClick={() => setStopTarget(null)}
            >
              继续运行
            </button>
            <button
              className="library-button"
              disabled={!!busy}
              onClick={() => void change("stop", stopTarget)}
            >
              确认停止
            </button>
          </div>
        </dialog>
      ) : null}
    </main>
  );
}
