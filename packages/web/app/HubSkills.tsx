import React from "react";
import { ApiError } from "./auth.js";
import { setSkillEnabled } from "./configuration.js";
import {
  readSkills,
  readManagedSkill,
  createSkill,
  editSkill,
  removeSkill,
  previewGithubSkills,
  installGithubSkill,
  previewSkillUpdate,
  applySkillUpdate,
  newSkillContent,
  validSkillName,
  visibleSkills,
  type ManagedSkill,
  type SkillsSnapshot,
  type SkillDetail,
  type GithubPreview,
  type SkillUpdatePreview,
  type SkillMutationResult,
} from "./skills-management.js";
import "./hub-skills.css";

interface Props {
  onAuthLost: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onChanged?: () => void;
  configurationVersion?: number;
}
type Pane =
  | { kind: "create" }
  | { kind: "detail"; detail: SkillDetail }
  | { kind: "import"; preview?: GithubPreview }
  | { kind: "update"; preview: SkillUpdatePreview }
  | { kind: "remove"; skill: ManagedSkill };
type Run = <T>(
  label: string,
  work: (signal: AbortSignal) => Promise<T>,
  mutation?: boolean,
) => Promise<T | undefined>;
const sourceLabels: Record<ManagedSkill["source"], string> = {
  project: "工作区",
  user: "用户级",
  plugin: "插件",
  "panel-app": "Panel App",
};

export function HubSkills({
  onAuthLost,
  onChanged,
  onDirtyChange,
  configurationVersion = 0,
}: Props) {
  const [snapshot, setSnapshot] = React.useState<SkillsSnapshot | null>(null);
  const [pane, setPane] = React.useState<Pane | null>(null);
  const [query, setQuery] = React.useState("");
  const [scope, setScope] = React.useState("all");
  const [busy, setBusy] = React.useState("");
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [reload, setReload] = React.useState(0);
  const [paneDirty, setPaneDirty] = React.useState(false);
  const [discardAsked, setDiscardAsked] = React.useState(false);
  const operation = React.useRef<AbortController | null>(null);
  const read = React.useRef<AbortController | null>(null);
  const queuedRefresh = React.useRef(false);
  const callbacks = React.useRef({ onAuthLost, onChanged });
  callbacks.current = { onAuthLost, onChanged };
  const heading = React.useRef<HTMLHeadingElement | null>(null);
  const opener = React.useRef<HTMLElement | null>(null);

  const report = React.useCallback((cause: unknown) => {
    if (cause instanceof ApiError && cause.status === 401) callbacks.current.onAuthLost();
    else setError(cause instanceof Error ? cause.message : "操作失败，请重试。");
  }, []);

  React.useEffect(
    () => () => {
      operation.current?.abort();
      read.current?.abort();
    },
    [],
  );
  React.useEffect(() => {
    if (operation.current) {
      queuedRefresh.current = true;
      return;
    }
    const controller = new AbortController();
    read.current = controller;
    void readSkills(controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setSnapshot(next);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) report(cause);
      });
    return () => controller.abort();
  }, [reload, configurationVersion, report]);
  React.useEffect(() => {
    if (pane) heading.current?.focus();
  }, [pane?.kind]);

  const open = (next: Pane) => {
    opener.current = document.activeElement as HTMLElement | null;
    setError("");
    setNotice("");
    setPaneDirty(false);
    setDiscardAsked(false);
    setPane(next);
  };
  const finishClose = () => {
    setPane(null);
    setPaneDirty(false);
    setDiscardAsked(false);
    setError("");
    opener.current?.focus();
  };
  const close = () => {
    if (operation.current) return;
    if (paneDirty) {
      setDiscardAsked(true);
      return;
    }
    finishClose();
  };
  const run: Run = async (label, work, mutation = false) => {
    if (operation.current) return undefined;
    read.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      const result = await work(controller.signal);
      if (controller.signal.aborted) return undefined;
      if (mutation) {
        try {
          const next = await readSkills(controller.signal);
          if (!controller.signal.aborted) setSnapshot(next);
        } catch (cause) {
          if (cause instanceof ApiError && cause.status === 401) throw cause;
          if (!controller.signal.aborted)
            setError("操作已完成，但列表刷新失败。请点击刷新查看最新状态。");
        }
        if (controller.signal.aborted) return undefined;
        setNotice((result as SkillMutationResult).message || "设置已保存，下次任务生效。");
        callbacks.current.onChanged?.();
      }
      return result;
    } catch (cause) {
      if (!controller.signal.aborted) report(cause);
      return undefined;
    } finally {
      if (operation.current === controller) operation.current = null;
      if (!controller.signal.aborted) {
        setBusy("");
        if (queuedRefresh.current) {
          queuedRefresh.current = false;
          setReload((value) => value + 1);
        }
      }
    }
  };

  React.useEffect(() => {
    onDirtyChange?.(paneDirty || !!busy);
    return () => onDirtyChange?.(false);
  }, [paneDirty, busy, onDirtyChange]);

  const skills = visibleSkills(snapshot?.skills ?? [], query, scope);
  return (
    <section
      className="hub-skills"
      aria-labelledby="skills-title"
      onKeyDown={(event) => {
        if (event.key === "Escape" && pane && !busy) {
          event.preventDefault();
          close();
        }
      }}
    >
      <header className="skills-heading">
        <div>
          <span className="skills-eyebrow">工作区能力</span>
          <h1 id="skills-title">Skills</h1>
          <p>创建工作说明，导入社区技能，把常用流程留在工作区。</p>
        </div>
        <div className="skills-actions">
          <button
            className="config-button"
            disabled={!!busy || !!pane}
            onClick={() => open({ kind: "import" })}
          >
            从 GitHub 导入
          </button>
          <button
            className="config-button config-button-primary"
            disabled={!!busy || !!pane}
            onClick={() => open({ kind: "create" })}
          >
            ＋ 创建 Skill
          </button>
        </div>
      </header>
      {error && (
        <div className="config-message config-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="config-message config-success" role="status">
          {notice}
        </div>
      )}
      {busy && (
        <p className="skills-progress" role="status">
          {busy}…
        </p>
      )}
      {pane && (
        <section className="skills-workspace-panel" aria-labelledby="skills-panel-title">
          <header>
            <h2 id="skills-panel-title" ref={heading} tabIndex={-1}>
              {pane.kind === "create"
                ? "创建 Skill"
                : pane.kind === "detail"
                  ? pane.detail.editable
                    ? `编辑 ${pane.detail.name}`
                    : pane.detail.name
                  : pane.kind === "import"
                    ? "从 GitHub 导入"
                    : pane.kind === "update"
                      ? `更新 ${pane.preview.name}`
                      : `移除 ${pane.skill.name}`}
            </h2>
            <button className="config-button config-button-quiet" disabled={!!busy} onClick={close}>
              关闭
            </button>
          </header>
          {discardAsked && (
            <div className="skills-discard-confirm" role="alert">
              <p>还有未保存的修改。关闭会丢弃这些修改。</p>
              <div className="skills-actions">
                <button className="config-button" onClick={() => setDiscardAsked(false)}>
                  继续编辑
                </button>
                <button className="config-button skills-danger" onClick={finishClose}>
                  放弃修改并关闭
                </button>
              </div>
            </div>
          )}
          {(pane.kind === "create" || pane.kind === "detail") && (
            <SkillEditor
              key={pane.kind === "detail" ? pane.detail.name + pane.detail.revision : "create"}
              detail={pane.kind === "detail" ? pane.detail : undefined}
              busy={!!busy}
              run={run}
              onSaved={finishClose}
              onDirtyChange={setPaneDirty}
            />
          )}
          {pane.kind === "import" && (
            <GithubImporter
              key={pane.preview?.reviewToken ?? "url"}
              preview={pane.preview}
              busy={!!busy}
              run={run}
              onPreview={(preview) => setPane({ kind: "import", preview })}
              onInstalled={finishClose}
            />
          )}
          {pane.kind === "update" && (
            <UpdatePreview preview={pane.preview} busy={!!busy} run={run} onUpdated={finishClose} />
          )}
          {pane.kind === "remove" && (
            <div className="skills-remove-confirm">
              <p>
                确认从当前工作区移除 <strong>{pane.skill.name}</strong>？它的
                SKILL.md、脚本和资源文件都会移除。
              </p>
              <p className="config-help">
                已保存的对话会保留。其他设备下一次运行任务时将不再使用这个工作区 Skill。
              </p>
              <div className="skills-actions">
                <button className="config-button" disabled={!!busy} onClick={close}>
                  取消
                </button>
                <button
                  className="config-button skills-danger"
                  disabled={!!busy}
                  onClick={() => {
                    void run(
                      "正在移除 Skill",
                      (signal) => removeSkill(pane.skill.name, pane.skill.revision, signal),
                      true,
                    ).then((result) => {
                      if (result) finishClose();
                    });
                  }}
                >
                  确认移除
                </button>
              </div>
            </div>
          )}
        </section>
      )}
      <div className="skills-filter">
        <label>
          <span className="config-sr-only">搜索 Skills</span>
          <input
            type="search"
            aria-label="搜索 Skills"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索名称或用途…"
          />
        </label>
        <select
          aria-label="Skill 来源"
          value={scope}
          onChange={(event) => setScope(event.target.value)}
        >
          <option value="all">全部来源</option>
          {Object.entries(sourceLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button
          className="config-button config-button-quiet"
          disabled={!!busy}
          onClick={() => {
            setError("");
            setReload((value) => value + 1);
          }}
        >
          刷新
        </button>
      </div>
      {!snapshot && !error ? (
        <p className="config-help">正在读取 Skills…</p>
      ) : snapshot ? (
        <p className="skills-count">
          {skills.length === snapshot.skills.length
            ? `${skills.length} 个 Skill`
            : `显示 ${skills.length} / ${snapshot.skills.length} 个 Skill`}
          {" · "}
          {snapshot.skills.filter((skill) => skill.enabled).length} 个已启用
        </p>
      ) : null}
      {snapshot && !skills.length && (
        <div className="skills-empty">
          <h2>{query || scope !== "all" ? "没有匹配的 Skills" : "从一个常用流程开始"}</h2>
          <p>
            {query || scope !== "all"
              ? "调整搜索词或来源筛选。"
              : "创建自己的 Skill，或粘贴 GitHub 地址导入完整的社区技能。"}
          </p>
        </div>
      )}
      <div className="skills-list">
        {skills.map((skill) => (
          <article className="skills-card" key={skill.name}>
            <div className="skills-card-heading">
              <div>
                <h2>{skill.name}</h2>
                <span className="config-badge">{sourceLabels[skill.source]}</span>
                {skill.origin && <span className="config-badge">GitHub</span>}
              </div>
              <button
                className="config-switch"
                role="switch"
                aria-checked={skill.enabled}
                aria-label={`${skill.enabled ? "停用" : "启用"} ${skill.name}`}
                disabled={!!busy || !!skill.disabledReason}
                title={skill.disabledReason}
                onClick={() => {
                  void run(
                    "正在更新 Skill",
                    async (signal) => {
                      await setSkillEnabled(skill.name, !skill.enabled, signal);
                      return {
                        ok: true,
                        name: skill.name,
                        message: skill.enabled
                          ? "Skill 已停用，下次任务生效。"
                          : "Skill 已启用，下次任务生效。",
                      };
                    },
                    true,
                  );
                }}
              >
                <span />
              </button>
            </div>
            <p>{skill.description || "暂未填写用途描述。"}</p>
            {skill.origin && (
              <p className="skills-source">
                {skill.origin.url.replace("https://github.com/", "")} · {skill.origin.ref} ·{" "}
                {skill.origin.commit.slice(0, 8)}
              </p>
            )}
            {skill.readOnlyReason && <p className="config-help">{skill.readOnlyReason}</p>}
            {skill.disabledReason && <p className="config-help">{skill.disabledReason}</p>}
            <footer className="skills-actions">
              <button
                className="config-button config-button-quiet"
                disabled={!!busy || !!pane}
                onClick={() => {
                  opener.current = document.activeElement as HTMLElement | null;
                  void run("正在读取 Skill", (signal) => readManagedSkill(skill.name, signal)).then(
                    (detail) => {
                      if (detail) open({ kind: "detail", detail });
                    },
                  );
                }}
              >
                {skill.editable ? "查看与编辑" : "查看说明"}
              </button>
              {skill.editable && skill.origin && (
                <button
                  className="config-button config-button-quiet"
                  disabled={!!busy || !!pane}
                  onClick={() => {
                    void run("正在检查来源更新", (signal) =>
                      previewSkillUpdate(skill.name, skill.revision, signal),
                    ).then((preview) => {
                      if (preview?.changed) open({ kind: "update", preview });
                      else if (preview) setNotice(`${skill.name} 已是最新版本。`);
                    });
                  }}
                >
                  检查更新
                </button>
              )}
              {skill.removable && (
                <button
                  className="config-button config-button-quiet skills-remove"
                  disabled={!!busy || !!pane}
                  onClick={() => open({ kind: "remove", skill })}
                >
                  移除
                </button>
              )}
            </footer>
          </article>
        ))}
      </div>
      {snapshot && (
        <details className="skills-directories">
          <summary>Skills 存在哪里</summary>
          <p>
            这里管理当前工作区。用户级、插件和 Panel App 的 Skills
            可以查看和启停，安装内容由各自来源管理。
          </p>
          <ul>
            {snapshot.directories.map((directory) => (
              <li key={directory}>
                <code>{directory}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function SkillEditor({
  detail,
  busy,
  run,
  onSaved,
  onDirtyChange,
}: {
  detail?: SkillDetail;
  busy: boolean;
  run: Run;
  onSaved: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [name, setName] = React.useState(detail?.name ?? "my-skill");
  const [content, setContent] = React.useState(detail?.content ?? newSkillContent("my-skill"));
  const dirty = content !== detail?.content;
  const editable = !detail || detail.editable;
  React.useEffect(() => {
    onDirtyChange(
      editable &&
        (detail
          ? content !== detail.content
          : name !== "my-skill" || content !== newSkillContent("my-skill")),
    );
  }, [content, name, detail, editable, onDirtyChange]);
  return (
    <form
      className="skills-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void run(
          detail ? "正在保存 Skill" : "正在创建 Skill",
          (signal) =>
            detail
              ? editSkill(detail.name, content, detail.revision, signal)
              : createSkill(name.trim(), content, signal),
          true,
        ).then((result) => {
          if (result) onSaved();
        });
      }}
    >
      <fieldset disabled={busy}>
        {!detail && (
          <label>
            <span>名称</span>
            <input
              required
              value={name}
              maxLength={128}
              onChange={(event) => {
                const next = event.target.value;
                if (content === newSkillContent(name)) setContent(newSkillContent(next));
                setName(next);
              }}
              aria-describedby="skill-name-help"
              aria-label="Skill 名称"
            />
            <small id="skill-name-help">字母、数字、短横线、下划线或点；创建后名称保持不变。</small>
            {!validSkillName(name) && <span className="skills-field-error">请输入有效名称。</span>}
          </label>
        )}
        <label>
          <span>
            {editable ? "SKILL.md" : "说明"}
            {detail && editable && dirty && <small className="skills-unsaved">未保存</small>}
          </span>
          <textarea
            value={content}
            readOnly={!editable}
            onChange={(event) => setContent(event.target.value)}
            rows={18}
            spellCheck={false}
            aria-label="SKILL.md 内容"
          />
        </label>
        {detail?.origin && editable && (
          <p className="config-help">
            手动编辑会保留 GitHub 来源；以后更新来源时，会预览将替换的完整内容。
          </p>
        )}
        {editable && (
          <div className="skills-actions">
            <span className="config-help">
              支持 Markdown 和 YAML Frontmatter。变更在下一次任务中生效。
            </span>
            <button
              className="config-button config-button-primary"
              type="submit"
              disabled={
                !content.trim() || (!detail && !validSkillName(name)) || (!!detail && !dirty)
              }
            >
              {detail ? "保存修改" : "创建 Skill"}
            </button>
          </div>
        )}
      </fieldset>
    </form>
  );
}

function GithubImporter({
  preview,
  busy,
  run,
  onPreview,
  onInstalled,
}: {
  preview?: GithubPreview;
  busy: boolean;
  run: Run;
  onPreview: (preview: GithubPreview) => void;
  onInstalled: () => void;
}) {
  const [url, setUrl] = React.useState("");
  const [selected, setSelected] = React.useState(preview?.skills[0]?.pathInRepo ?? "");
  const [name, setName] = React.useState(preview?.skills[0]?.name ?? "");
  if (!preview)
    return (
      <form
        className="skills-import-url"
        onSubmit={(event) => {
          event.preventDefault();
          void run("正在检查 GitHub 来源", (signal) => previewGithubSkills(url, signal)).then(
            (result) => {
              if (result) onPreview(result);
            },
          );
        }}
      >
        <label>
          <span>GitHub 仓库或 Skill 目录地址</span>
          <input
            type="url"
            required
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://github.com/owner/repository/tree/main/skills/example"
            disabled={busy}
          />
        </label>
        <p className="config-help">先查看可导入的技能，再确认安装。脚本和资源文件会一起保留。</p>
        <button className="config-button config-button-primary" disabled={busy || !url.trim()}>
          预览来源
        </button>
      </form>
    );
  return (
    <form
      className="skills-import-preview"
      onSubmit={(event) => {
        event.preventDefault();
        void run(
          "正在导入 Skill 与资源",
          (signal) => installGithubSkill(preview.reviewToken, selected, name, signal),
          true,
        ).then((result) => {
          if (result) onInstalled();
        });
      }}
    >
      <p>
        <a href={preview.repoUrl} target="_blank" rel="noreferrer">
          {preview.repoUrl.replace("https://github.com/", "")}
        </a>{" "}
        <span className="config-badge">{preview.commit.slice(0, 8)}</span>
      </p>
      {preview.warning && <p className="config-help">{preview.warning}</p>}
      <fieldset disabled={busy}>
        <legend>选择一个 Skill</legend>
        <div className="skills-source-choices">
          {preview.skills.map((skill) => (
            <label key={skill.pathInRepo}>
              <input
                type="radio"
                name="github-skill"
                checked={selected === skill.pathInRepo}
                onChange={() => {
                  setSelected(skill.pathInRepo);
                  setName(skill.name);
                }}
              />
              <span>
                <strong>{skill.name}</strong>
                <small>{skill.description || skill.pathInRepo}</small>
                {skill.alreadyInstalled && <small>已有同名 Skill，可修改安装名称。</small>}
              </span>
            </label>
          ))}
        </div>
        {!!preview.skills.length && (
          <>
            <label>
              <span>安装到工作区时使用的名称</span>
              <input
                required
                maxLength={128}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <p className="config-help">将导入预览时的确定版本。不会执行其中的脚本。</p>
            <button
              className="config-button config-button-primary"
              disabled={!selected || !validSkillName(name)}
              type="submit"
            >
              确认导入到工作区
            </button>
          </>
        )}
      </fieldset>
    </form>
  );
}

function UpdatePreview({
  preview,
  busy,
  run,
  onUpdated,
}: {
  preview: SkillUpdatePreview;
  busy: boolean;
  run: Run;
  onUpdated: () => void;
}) {
  return (
    <div className="skills-update-preview">
      <p>
        来源版本 <code>{preview.currentCommit.slice(0, 8)}</code> →{" "}
        <code>{preview.latestCommit.slice(0, 8)}</code>
      </p>
      <p>确认后会用下方版本替换此 Skill 的说明、脚本和资源，包括你在其中做过的本地修改。</p>
      <details>
        <summary>查看将导入的 {preview.files?.length ?? 0} 个文件</summary>
        <ul>
          {preview.files?.map((file) => (
            <li key={file.path}>
              <code>{file.path}</code>
              <span>
                {Math.ceil(file.size / 1024)} KB{file.executable ? " · 可执行脚本" : ""}
              </span>
            </li>
          ))}
        </ul>
      </details>
      <label>
        <span>新的 SKILL.md</span>
        <textarea value={preview.content ?? ""} readOnly rows={16} aria-label="更新后的 SKILL.md" />
      </label>
      <button
        className="config-button config-button-primary"
        disabled={busy || !preview.reviewToken}
        onClick={() => {
          void run(
            "正在更新 Skill",
            (signal) => applySkillUpdate(preview.reviewToken!, signal),
            true,
          ).then((result) => {
            if (result) onUpdated();
          });
        }}
      >
        确认更新到预览版本
      </button>
    </div>
  );
}
