import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, MessageBoxOptions } from "electron";
import { randomUUID } from "node:crypto";
import type { LabProjectFiles, LabProjectScope } from "../shared/optimization-lab-project.js";
import { MAX_LAB_JSON_BYTES as MAX_JSON_BYTES } from "../shared/optimization-lab.js";
import { LAB_QUERY_TYPES, type LabAuthorizationInput } from "../shared/optimization-lab.js";
import type { EvidenceBundle } from "@cjhyy/code-shell-capability-optimization-lab";

const queryTypes = new Set<string>(LAB_QUERY_TYPES);
const forbidden = new Set(["cwd", "type", "projectTrusted", "confirmed", "authorized"]);

interface Deps {
  ipc: Pick<IpcMain, "handle" | "removeHandler">;
  windows(): BrowserWindow[];
  enabled(): boolean;
  waitForWorkerHost?(): Promise<void>;
  resolveTarget(target: unknown): Promise<{ kind: string; cwd: string }>;
  trusted(cwd: string): Promise<boolean>;
  documentSignal(event: IpcMainInvokeEvent): AbortSignal;
  files(scope: LabProjectScope, signal: AbortSignal): LabProjectFiles;
  query(type: string, params: Record<string, unknown>): Promise<any>;
  confirm(window: BrowserWindow, options: MessageBoxOptions): Promise<{ response: number }>;
  save(window: BrowserWindow, name: string): Promise<string | undefined>;
  choose(window: BrowserWindow): Promise<string | undefined>;
}

function datasetInput(input: unknown, exporting = false): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid dataset file input");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== "target" && !(exporting && key === "text")))
    throw new Error("Invalid dataset file input");
  // Bound target metadata separately: JSON escaping must not reduce the 16 MiB text limit.
  record({ target: value.target });
  if (exporting) {
    if (typeof value.text !== "string" || Buffer.byteLength(value.text, "utf8") > MAX_JSON_BYTES)
      throw new Error("Dataset text must be bounded UTF-8");
    if (
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(value.text)) !==
      value.text
    )
      throw new Error("Dataset text must be valid UTF-8");
  }
  return value;
}

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid Lab input");
  const value = input as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_JSON_BYTES)
    throw new Error("Lab input is too large");
  for (const key of Object.keys(value))
    if (forbidden.has(key)) throw new Error(`Lab input cannot contain ${key}`);
  return value;
}

function identity(input: Record<string, unknown>): void {
  if (typeof input.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.id))
    throw new Error("Invalid experiment ID");
}

function revision(input: Record<string, unknown>): void {
  if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0)
    throw new Error("Invalid experiment revision");
}

/** The dialog describes the immutable plan read from the worker, never a renderer summary. */
export function authorizationMessage(snapshot: any, input: LabAuthorizationInput): string {
  const plan = snapshot.plan;
  if (
    !plan ||
    snapshot.id !== input.id ||
    plan.planHash !== input.planHash ||
    snapshot.state?.revision !== input.expectedRevision
  ) {
    throw new Error("Experiment changed; refresh the frozen plan before authorizing");
  }
  const connections = plan.connections ?? {};
  const describeConnection = (role: string) => {
    const connection = connections[role] ?? {};
    return `${connection.connectionId ?? "?"} / ${connection.modelId ?? "?"} (${connection.providerKind ?? "?"})\n${connection.endpoint ?? "?"}\nConfiguration hash: ${connection.configHash ?? "?"}`;
  };
  const operations = [plan.bounds?.trial, plan.bounds?.optimization];
  const bounded =
    Object.values(connections).every(
      (connection: any) => connection.outputCapCoversReasoning === true,
    ) && operations.every((operation) => operation?.inputTokenUpperBound != null);
  const tokenBound = bounded
    ? Math.max(
        ...operations.map(
          (operation) => operation.inputTokenUpperBound + operation.maxOutputTokens,
        ),
      ) * input.limits.maxRequests
    : null;
  return [
    `Experiment / 实验: ${input.id}`,
    `Plan hash / 计划哈希: ${input.planHash}`,
    ...(plan.fixedCandidate
      ? [
          `Fixed candidate trial / 固定候选试用: ${plan.fixedCandidate.candidateHash}\nBody: ${plan.fixedCandidate.bodyHash}\nSource experiment: ${plan.fixedCandidate.sourceExperimentId}\nSource plan/report: ${plan.fixedCandidate.sourcePlanHash} / ${plan.fixedCandidate.sourceReportHash}\nNo optimizer calls; this does not adopt the candidate into ordinary tasks. / 无优化调用，不会采用到普通任务。`,
        ]
      : []),
    `Skill: ${plan.skill?.name ?? "?"}\nRevision / 修订: ${plan.skill?.revision ?? "?"}`,
    `Evaluation mode / 评估模式: ${plan.runnerVersion === "codeshell_isolated_v1" ? "Isolated ephemeral Engine/Session with fixed instructions, no tools / 固定指令的临时隔离 Engine/Session，无工具" : "Standalone text fragment / 独立文本片段"}`,
    `Target model / 目标模型: ${describeConnection("target")}`,
    `Optimizer / 优化模型: ${plan.fixedCandidate ? "none / 不调用" : describeConnection("optimizer")}`,
    `Dataset hash / 样本哈希: ${plan.datasetHash ?? "?"}\nCounts / 数量: ${JSON.stringify(snapshot.datasetSummary ?? "see reviewed frozen dataset / 见已审核冻结样本")}`,
    `External data / 外发数据: ${JSON.stringify(plan.externalData)}\n${plan.fixedCandidate ? "Only the target receives the frozen body and current case; there are no optimizer calls. Grading stays local. / 仅目标模型接收固定正文和当前题，不调用优化模型，评分留在本地。" : "Target receives Skill and current case input; optimizer receives Skill and development feedback; holdout never enters optimizer; grading stays local. / 目标模型接收正文和当前题，优化模型接收正文和开发反馈，保留题不进入优化模型，本地人工评分。"}`,
    `Output limits / 输出限制: ${JSON.stringify(plan.bounds)}\nFinal evaluation allocation / 最终验收预留: ${JSON.stringify(plan.finalAllocation)}`,
    `Request limit / 请求上限: ${input.limits.maxRequests}`,
    `Execution time limit / 执行时间上限: ${input.limits.maxExecutionMs} ms`,
    `Worst-case Tokens / Token 最坏上界: ${tokenBound ?? "unknown / 无法保证上界"}\nWorst-case USD / 费用最坏上界: ${snapshot.estimate?.worstCaseCostUsd ?? "unknown / 无法保证上界"}`,
    `Token stop threshold / Token 停止阈值: ${input.limits.maxEstimatedTokens ?? "unknown / 未设定"}`,
    `Estimated USD stop threshold / 估算费用停止阈值: ${input.limits.maxEstimatedCostUsd ?? "unknown / 未设定"}`,
    `Expires / 授权到期: ${input.expiresAt}`,
    "Token and fee thresholds are estimates, not a provider billing cap. Unknown usage remains charged against the experiment. / Token 与费用阈值不是供应商账单硬封顶，未知用量会保守保留。",
    "This authorizes only this experiment. Candidates do not become active Skills. / 仅授权本次实验，候选不会自动成为生效 Skill。",
  ].join("\n\n");
}

/** Local top-frame bridge; no raw worker grant is exposed through preload or Web. */
export function registerOptimizationLabIpc(deps: Deps): () => void {
  const channels: string[] = [];
  // Preview receipts are window/project bound and short-lived; arbitrary renderer bundles are refused.
  const previews = new Map<
    string,
    {
      window: BrowserWindow;
      frame: BrowserWindow["webContents"]["mainFrame"];
      cwd: string;
      bundle: EvidenceBundle;
      expiresAt: number;
    }
  >();
  const owner = (event: IpcMainInvokeEvent): BrowserWindow => {
    const window = deps.windows().find((w) => !w.isDestroyed() && w.webContents === event.sender);
    if (!window || event.senderFrame !== event.sender.mainFrame)
      throw new Error("Lab requires an application top frame");
    if (!deps.enabled()) throw new Error("Optimization Lab is disabled");
    return window;
  };
  const resolve = async (
    input: Record<string, unknown>,
    check: () => void,
  ): Promise<Record<string, unknown> & { cwd: string }> => {
    check();
    await deps.waitForWorkerHost?.();
    check();
    const target = await deps.resolveTarget(input.target);
    check();
    if (target.kind !== "project") throw new Error("Lab requires a trusted tracked project");
    const trusted = await deps.trusted(target.cwd);
    check();
    if (!trusted) throw new Error("Lab requires a trusted tracked project");
    const { target: _target, ...params } = input;
    return { ...params, cwd: target.cwd };
  };
  type FrameCheck = (() => void) & { signal: AbortSignal };
  const handle = (
    channel: string,
    handler: (window: BrowserWindow, args: unknown[], check: FrameCheck) => Promise<unknown>,
  ) => {
    channels.push(channel);
    deps.ipc.handle(channel, (event, ...args) => {
      const window = owner(event);
      const frame = event.senderFrame;
      const check = () => {
        if (owner(event) !== window || event.sender.mainFrame !== frame)
          throw new Error("Lab originating frame changed");
      };
      return handler(window, args, Object.assign(check, { signal: deps.documentSignal(event) }));
    });
  };
  const query = async (check: () => void, type: string, params: Record<string, unknown>) => {
    check();
    const result = await deps.query(type, params);
    check();
    return result;
  };
  const fileRevalidation = (
    window: BrowserWindow,
    input: Record<string, unknown>,
    cwd: string,
    assertOriginal: () => void,
  ): (() => Promise<void>) => {
    const frame = window.webContents.mainFrame;
    const available = () => {
      assertOriginal();
      if (
        window.isDestroyed() ||
        !deps.windows().includes(window) ||
        window.webContents.mainFrame !== frame ||
        !deps.enabled()
      )
        throw new Error("Lab file operation is no longer available");
    };
    return async () => {
      available();
      const current = await resolve(input, assertOriginal);
      available();
      if (current.cwd !== cwd) throw new Error("Project primary changed during file operation");
    };
  };
  const projectFiles = (input: Record<string, unknown>, cwd: string, check: FrameCheck) => {
    const projectId = (input.target as { projectId?: unknown })?.projectId;
    if (typeof projectId !== "string" || !projectId) throw Error("Lab requires a stable project");
    check();
    return deps.files({ projectId, cwd }, check.signal);
  };
  handle("optimizationLab:query", async (_window, args, check) => {
    if (args.length !== 2 || typeof args[0] !== "string" || !queryTypes.has(args[0]))
      throw new Error("Unsupported Lab query");
    const input = record(args[1]);
    const params = await resolve(input, check);
    const result = await query(check, `optimization_lab_${args[0]}`, params);
    if (args[0] !== "discover") return result;
    const skills = await projectFiles(input, params.cwd, check).skills();
    check();
    return { ...result, skills };
  });
  handle("optimizationLab:previewEvidence", async (window, args, check) => {
    if (args.length !== 1) throw new Error("Evidence import unavailable");
    const input = record(args[0]);
    if (
      Object.keys(input).some((key) => !["target", "runIds"].includes(key)) ||
      !Array.isArray(input.runIds) ||
      input.runIds.length < 1 ||
      input.runIds.length > 20 ||
      input.runIds.some((id) => typeof id !== "string" || id.length > 512)
    )
      throw new Error("Invalid selected run IDs");
    const params = await resolve(input, check);
    const revalidate = fileRevalidation(window, input, params.cwd, check);
    const bundle = await projectFiles(input, params.cwd, check).evidence(input.runIds as string[]);
    await revalidate();
    for (const [id, prior] of previews)
      if (prior.window === window || prior.expiresAt <= Date.now()) previews.delete(id);
    if (previews.size >= 32) throw new Error("Too many evidence previews");
    const previewId = randomUUID();
    previews.set(previewId, {
      window,
      frame: window.webContents.mainFrame,
      cwd: params.cwd,
      bundle,
      expiresAt: Date.now() + 10 * 60_000,
    });
    return { previewId, bundle };
  });
  handle("optimizationLab:importEvidence", async (window, args, check) => {
    if (args.length !== 1) throw new Error("Invalid evidence confirmation");
    const input = record(args[0]);
    if (
      Object.keys(input).some((key) => !["target", "previewId", "bundleHash"].includes(key)) ||
      typeof input.previewId !== "string"
    )
      throw new Error("Invalid evidence confirmation");
    const params = await resolve(input, check);
    const prior = previews.get(input.previewId);
    if (
      !prior ||
      prior.window !== window ||
      prior.frame !== window.webContents.mainFrame ||
      prior.cwd !== params.cwd ||
      prior.expiresAt <= Date.now() ||
      prior.bundle.bundleHash !== input.bundleHash
    )
      throw new Error("Evidence preview expired or changed");
    const revalidate = fileRevalidation(window, input, params.cwd, check);
    const confirmation = await deps.confirm(window, {
      type: "question",
      title: "Optimization Lab / 优化实验室",
      message: "Import this reviewed evidence locally? / 将已预览证据导入本地？",
      detail: `Bundle: ${prior.bundle.bundleHash}\nSelected runs: ${prior.bundle.runs.map((run) => run.runId).join(", ")}\nSecrets are filtered heuristically; review personal data yourself. No model call is authorized. Imported cases remain analysis_only until you confirm the input and independent criteria. / 脱敏为启发式处理，个人信息需人工复核。本次不授权模型调用，样本默认仅用于分析。`,
      buttons: ["Cancel / 取消", "Import / 导入"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response !== 1) return null;
    await revalidate();
    if (previews.get(input.previewId) !== prior || prior.expiresAt <= Date.now())
      throw new Error("Evidence preview expired or changed");
    previews.delete(input.previewId);
    return query(check, "optimization_lab_import_evidence", {
      cwd: params.cwd,
      bundle: prior.bundle,
    });
  });
  handle("optimizationLab:adopt", async (window, args, check) => {
    if (args.length !== 1) throw new Error("Invalid adoption request");
    const input = record(args[0]);
    identity(input);
    if (
      Object.keys(input).some((key) => !["target", "id", "reportHash", "scope"].includes(key)) ||
      typeof input.reportHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.reportHash)
    )
      throw new Error("Invalid adoption request");
    const scope = input.scope as Record<string, unknown> | undefined;
    if (
      !scope ||
      (scope.kind !== "project" && scope.kind !== "session") ||
      Object.keys(scope).some((key) => !["kind", "sessionId"].includes(key)) ||
      (scope.kind === "project" && scope.sessionId !== undefined) ||
      (scope.kind === "session" &&
        (typeof scope.sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(scope.sessionId)))
    )
      throw new Error("Choose an explicit project or Session scope");
    const params = await resolve(input, check);
    const request = {
      cwd: params.cwd,
      id: input.id,
      ...(scope.kind === "session" ? { sessionId: scope.sessionId } : {}),
    };
    const preview = await query(check, "optimization_lab_adoption_preview", request);
    if (preview.reportHash !== input.reportHash) throw new Error("Adoption report changed");
    const detail = `Skill: ${preview.skillName}\nSource revision: ${preview.sourceRevision}\nReport: ${preview.reportHash}\nProject: ${params.cwd}\nScope: ${scope.kind === "session" ? `Session ${scope.sessionId} (next run)` : "new Sessions in this project"}\nModel: ${preview.scope.provider} / ${preview.scope.model}\n\n${preview.body}\n\nThis is a no-tools isolated instruction evaluation. No tool workflow was validated. Source SKILL.md is preserved. Revoke to stop runs using this revision and restore the source for future runs. / 这是无工具的隔离指令验证，未验证有工具工作流。源 Skill 保留，撤销会停止使用该版本的运行。`;
    const result = await deps.confirm(window, {
      type: "question",
      title: "Optimization Lab / 优化实验室",
      message: "Adopt this exact revision in the selected scope? / 在指定范围采用这个固定版本？",
      detail,
      buttons: ["Cancel / 取消", "Adopt / 采用"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (result.response !== 1) return null;
    const revalidate = fileRevalidation(window, input, params.cwd, check);
    await revalidate();
    const latest = await query(check, "optimization_lab_adoption_preview", request);
    if (JSON.stringify(latest) !== JSON.stringify(preview))
      throw new Error("Adoption evidence changed during confirmation");
    return query(check, "optimization_lab_adopt", { ...request, reportHash: preview.reportHash });
  });
  handle("optimizationLab:authorize", async (window, args, check) => {
    if (args.length !== 1) throw new Error("Invalid Lab authorization");
    const input = record(args[0]);
    identity(input);
    revision(input);
    if (
      typeof input.planHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.planHash) ||
      typeof input.operationId !== "string" ||
      input.operationId.length < 1 ||
      input.operationId.length > 128 ||
      typeof input.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(input.expiresAt)) ||
      Date.parse(input.expiresAt) <= Date.now()
    )
      throw new Error("Invalid Lab authorization");
    const limits = input.limits as Record<string, unknown> | undefined;
    if (
      !limits ||
      typeof limits !== "object" ||
      Array.isArray(limits) ||
      Object.keys(limits).some(
        (key) =>
          !["maxRequests", "maxExecutionMs", "maxEstimatedTokens", "maxEstimatedCostUsd"].includes(
            key,
          ),
      )
    )
      throw new Error("Invalid Lab limits");
    for (const key of ["maxRequests", "maxExecutionMs"])
      if (!Number.isSafeInteger(limits[key]) || Number(limits[key]) <= 0)
        throw new Error("Invalid Lab limits");
    for (const key of ["maxEstimatedTokens", "maxEstimatedCostUsd"])
      if (
        limits[key] != null &&
        (typeof limits[key] !== "number" ||
          !Number.isFinite(limits[key]) ||
          Number(limits[key]) <= 0)
      )
        throw new Error("Invalid Lab limits");
    const params = await resolve(input, check);
    const snapshot = await query(check, "optimization_lab_get", { cwd: params.cwd, id: params.id });
    const message = authorizationMessage(snapshot, input as unknown as LabAuthorizationInput);
    const confirmation = await deps.confirm(window, {
      type: "question",
      title: "Optimization Lab / 优化实验室",
      message: "Authorize this frozen experiment? / 授权这个冻结实验？",
      detail: message,
      buttons: ["Cancel / 取消", "Authorize / 授权"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response !== 1) return null;
    // Re-resolve mounted primary, trust and flag after a potentially long native dialog.
    if (window.isDestroyed() || !deps.enabled())
      throw new Error("Lab authorization is no longer available");
    const current = await resolve(input, check);
    if (current.cwd !== params.cwd) throw new Error("Project primary changed during authorization");
    authorizationMessage(
      await query(check, "optimization_lab_get", { cwd: params.cwd, id: params.id }),
      input as unknown as LabAuthorizationInput,
    );
    return query(check, "optimization_lab_grant", params);
  });
  handle("optimizationLab:exportFile", async (window, args, check) => {
    if (args.length !== 1) throw new Error("Invalid Lab export");
    const input = record(args[0]);
    identity(input);
    if (!["grading", "report-json", "report-markdown"].includes(String(input.kind)))
      throw new Error("Invalid export kind");
    const params = await resolve(input, check);
    const grading = input.kind === "grading";
    const revalidate = fileRevalidation(window, input, params.cwd, check);
    const artifact = await query(
      check,
      grading ? "optimization_lab_export_grading" : "optimization_lab_report",
      { cwd: params.cwd, id: input.id },
    );
    const markdown = input.kind === "report-markdown";
    const content = markdown
      ? artifact.markdown
      : JSON.stringify(grading ? artifact : artifact.json, null, 2);
    if (typeof content !== "string" || Buffer.byteLength(content) > MAX_JSON_BYTES)
      throw new Error("Invalid report artifact");
    const destination = await deps.save(
      window,
      `optimization-${input.id}-${String(input.kind)}.${markdown ? "md" : "json"}`,
    );
    if (!destination) return false;
    await revalidate();
    await projectFiles(input, params.cwd, check).writePicked(destination, content, revalidate);
    return true;
  });
  handle("optimizationLab:importGrading", async (window, args, check) => {
    if (args.length !== 1) throw new Error("Invalid grading import");
    const input = record(args[0]);
    identity(input);
    revision(input);
    const params = await resolve(input, check);
    const revalidate = fileRevalidation(window, input, params.cwd, check);
    const source = await deps.choose(window);
    if (!source) return null;
    await revalidate();
    const grading = JSON.parse(await projectFiles(input, params.cwd, check).readPicked(source));
    await revalidate();
    return query(check, "optimization_lab_import_grading", {
      cwd: params.cwd,
      id: params.id,
      expectedRevision: input.expectedRevision,
      grading,
    });
  });
  handle("optimizationLab:importDataset", async (window, args, check) => {
    if (args.length !== 1) throw new Error("Invalid dataset import");
    const input = datasetInput(args[0]);
    const params = await resolve(input, check);
    const revalidate = fileRevalidation(window, input, params.cwd, check);
    const source = await deps.choose(window);
    if (!source) return null;
    await revalidate();
    const text = await projectFiles(input, params.cwd, check).readPicked(source);
    await revalidate();
    return text;
  });
  handle("optimizationLab:exportDataset", async (window, args, check) => {
    if (args.length !== 1) throw new Error("Invalid dataset export");
    const input = datasetInput(args[0], true);
    const params = await resolve(input, check);
    const revalidate = fileRevalidation(window, input, params.cwd, check);
    const destination = await deps.save(window, "optimization-dataset.json");
    if (!destination) return false;
    await revalidate();
    await projectFiles(input, params.cwd, check).writePicked(
      destination,
      input.text as string,
      revalidate,
    );
    return true;
  });
  return () => {
    previews.clear();
    for (const channel of channels) deps.ipc.removeHandler(channel);
  };
}
